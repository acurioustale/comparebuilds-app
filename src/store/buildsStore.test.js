/**
 * Behaviour tests for the builds store.
 *
 * These drive the real Zustand store end-to-end: Vitest resolves the
 * `import.meta.glob` data loader, so `addBuild` dynamically imports actual class
 * JSON and parses real (generated) build strings — exercising the spec-identity,
 * dedup, limit, mismatch, reset, and hero-sanitisation logic that had no
 * coverage before.
 */

import { describe, test, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  useBuildsStore,
  MAX_BUILDS,
  MAX_BUILD_NAME_LEN,
} from "./buildsStore.js";
import { collectClassNodes, generateBuildString } from "../lib/buildString.js";
import { wireLayout } from "../lib/wireLayout.js";

const require = createRequire(import.meta.url);
const get = () => useBuildsStore.getState();

const DK_BLOOD = require("../data/death_knight.json").specs.blood.specId;
const MAGE_FIRE = require("../data/mage.json").specs.fire.specId;

/**
 * Generates `n` distinct, well-formed build strings for one class+spec by
 * selecting the first 1..n non-granted nodes (distinct selections → distinct
 * strings, all sharing the same specId).
 */
function genStrings(classSlug, specSlug, n) {
  const data = require(`../data/${classSlug}.json`);
  const classNodes = collectClassNodes(data);
  const spec = data.specs[specSlug];
  const pickable = spec.nodes.filter((nd) => !nd.alreadyGranted);
  assert.ok(
    pickable.length >= n,
    `fixture needs >= ${n} pickable nodes, has ${pickable.length}`,
  );
  const out = [];
  for (let k = 1; k <= n; k++) {
    const sel = {};
    for (let i = 0; i < k; i++) {
      const nd = pickable[i];
      sel[nd.id] = {
        pointsInvested:
          nd.type === "choice" ? nd.choices[0].maxRanks : nd.maxRanks,
        entryChosen: nd.type === "choice" ? 0 : null,
      };
    }
    out.push(generateBuildString(sel, spec.specId, classNodes));
  }
  return out;
}

beforeEach(() => {
  get().clearAllBuilds();
});

// ── Validation ────────────────────────────────────────────────────────────────

describe("addBuild validation", () => {
  test("rejects a non-string", async () => {
    await get().addBuild(null);
    assert.ok(get().error, "expected an error");
    assert.strictEqual(get().buildStrings.length, 0);
  });

  test("rejects an unknown spec id", async () => {
    const dk = require("../data/death_knight.json");
    const bogus = generateBuildString({}, 9999, collectClassNodes(dk)); // 9999 ∉ index
    await get().addBuild(bogus);
    assert.match(get().error ?? "", /not found in the local class index/);
    assert.strictEqual(get().buildStrings.length, 0);
  });

  test("rejects an over-length string before any parsing", async () => {
    await get().addBuild("A".repeat(2001));
    assert.match(get().error ?? "", /too long/);
    assert.strictEqual(get().buildStrings.length, 0);
  });

  test("surfaces an unsupported-version error", async () => {
    // 'AAAAAAAA' decodes to version 0; only version 2 is supported.
    await get().addBuild("AAAAAAAA");
    assert.match(
      get().error ?? "",
      /unsupported build string version|newer game format/i,
    );
    assert.strictEqual(get().buildStrings.length, 0);
  });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe("addBuild loads tree data", () => {
  test("accepts a valid string, parses it, and loads the tree", async () => {
    const [s] = genStrings("death_knight", "blood", 1);
    await get().addBuild(s);
    const st = get();
    assert.strictEqual(st.error, null);
    assert.strictEqual(st.buildStrings.length, 1);
    assert.ok(st.treeData, "treeData should be loaded");
    assert.ok(st.parsedBuilds[0], "build should be parsed");
    assert.strictEqual(st.specId, DK_BLOOD);
    assert.ok(Number.isInteger(st.classId), "classId should be set");
  });
});

// ── Dedup / limit / mismatch ──────────────────────────────────────────────────

describe("addBuild guards", () => {
  test("rejects an exact duplicate", async () => {
    const [s] = genStrings("death_knight", "blood", 1);
    await get().addBuild(s);
    await get().addBuild(s);
    assert.match(get().error ?? "", /already been added/);
    assert.strictEqual(get().buildStrings.length, 1);
  });

  test("enforces MAX_BUILDS", async () => {
    const strs = genStrings("death_knight", "blood", MAX_BUILDS + 1);
    for (let i = 0; i < MAX_BUILDS; i++) await get().addBuild(strs[i]);
    assert.strictEqual(get().buildStrings.length, MAX_BUILDS);
    assert.strictEqual(get().error, null);
    await get().addBuild(strs[MAX_BUILDS]);
    assert.match(get().error ?? "", /at most/);
    assert.strictEqual(get().buildStrings.length, MAX_BUILDS);
  });

  test("rejects a different spec", async () => {
    const [dk] = genStrings("death_knight", "blood", 1);
    const [mage] = genStrings("mage", "fire", 1);
    await get().addBuild(dk);
    await get().addBuild(mage);
    assert.match(get().error ?? "", /Spec mismatch/);
    assert.strictEqual(get().buildStrings.length, 1);
    assert.strictEqual(get().specId, DK_BLOOD);
  });
});

describe("addBuild concurrency", () => {
  test("two concurrent first-builds both land (no clobber)", async () => {
    const [a, b] = genStrings("death_knight", "blood", 2);
    // Dispatch both before the first resolves its tree-data load.
    await Promise.all([get().addBuild(a), get().addBuild(b)]);
    assert.strictEqual(get().buildStrings.length, 2);
    assert.deepStrictEqual([...get().buildStrings].sort(), [a, b].sort());
  });

  test("concurrent first-builds of different specs don't corrupt specId", async () => {
    const [dk] = genStrings("death_knight", "blood", 1);
    const [mage] = genStrings("mage", "fire", 1);
    await Promise.all([get().addBuild(dk), get().addBuild(mage)]);
    // First commit wins the spec; the other is rejected as a mismatch.
    assert.strictEqual(get().buildStrings.length, 1);
    assert.strictEqual(get().specId, DK_BLOOD);
    assert.deepStrictEqual(get().buildStrings, [dk]);
  });
});

// ── Removal / reset ───────────────────────────────────────────────────────────

describe("removeBuild and reset", () => {
  test("removeBuild drops one and keeps the rest", async () => {
    const [a, b] = genStrings("death_knight", "blood", 2);
    await get().addBuild(a);
    await get().addBuild(b);
    assert.strictEqual(get().buildStrings.length, 2);
    get().removeBuild(0);
    assert.strictEqual(get().buildStrings.length, 1);
    assert.strictEqual(get().buildStrings[0], b);
  });

  test("removeBuild ignores out-of-range indices", async () => {
    const [a] = genStrings("death_knight", "blood", 1);
    await get().addBuild(a);
    get().removeBuild(5);
    get().removeBuild(-1);
    assert.strictEqual(get().buildStrings.length, 1);
  });

  test("removing the last build resets spec identity", async () => {
    const [a] = genStrings("death_knight", "blood", 1);
    await get().addBuild(a);
    get().removeBuild(0);
    const st = get();
    assert.strictEqual(st.buildStrings.length, 0);
    assert.strictEqual(st.specId, null);
    assert.strictEqual(st.classId, null);
    assert.strictEqual(st.treeData, null);
  });

  test("clearAllBuilds resets everything", async () => {
    const [a] = genStrings("death_knight", "blood", 1);
    await get().addBuild(a);
    get().clearAllBuilds();
    const st = get();
    assert.strictEqual(st.buildStrings.length, 0);
    assert.strictEqual(st.specId, null);
    assert.strictEqual(st.treeData, null);
  });
});

// ── preloadSpec ───────────────────────────────────────────────────────────────

describe("preloadSpec", () => {
  test("loads tree data and stays class-unlocked", async () => {
    await get().preloadSpec(DK_BLOOD);
    const st = get();
    assert.strictEqual(st.specId, DK_BLOOD);
    assert.strictEqual(
      st.classId,
      null,
      "classId stays null so the class grid is unlocked",
    );
    assert.ok(st.treeData);
    assert.strictEqual(typeof st.interactiveNodes, "object");
  });

  test("is a no-op once builds exist", async () => {
    const [a] = genStrings("death_knight", "blood", 1);
    await get().addBuild(a);
    const before = get().treeData;
    await get().preloadSpec(MAGE_FIRE);
    assert.strictEqual(get().specId, DK_BLOOD);
    assert.strictEqual(get().treeData, before);
  });

  test("ignores an unknown spec id", async () => {
    await get().preloadSpec(999999);
    assert.strictEqual(get().treeData, null);
  });

  test("re-selecting the current spec keeps an in-progress selection", async () => {
    await get().preloadSpec(DK_BLOOD);
    const classNode = get().treeData.nodes.find(
      (n) => n.treeType === "class" && !n.alreadyGranted,
    );
    const sel = { ...get().interactiveNodes };
    sel[classNode.id] = { pointsInvested: 1, entryChosen: null };
    get().setInteractiveNodes(sel);
    assert.ok(get().interactiveNodes[classNode.id], "node was selected");

    // Re-selecting the same spec must not reseed and wipe the selection.
    await get().preloadSpec(DK_BLOOD);
    assert.ok(
      get().interactiveNodes[classNode.id],
      "selection survives re-selecting the same spec",
    );
  });
});

// ── Build names ───────────────────────────────────────────────────────────────

describe("build names", () => {
  test("addBuild keeps buildNames parallel (new slots unnamed)", async () => {
    const [a, b] = genStrings("death_knight", "blood", 2);
    await get().addBuild(a);
    await get().addBuild(b);
    assert.deepStrictEqual(get().buildNames, ["", ""]);
  });

  test("setBuildName sets and clamps to the cap", async () => {
    const [a] = genStrings("death_knight", "blood", 1);
    await get().addBuild(a);
    get().setBuildName(0, "Raid ST");
    assert.strictEqual(get().buildNames[0], "Raid ST");
    get().setBuildName(0, "x".repeat(MAX_BUILD_NAME_LEN + 20));
    assert.strictEqual(get().buildNames[0].length, MAX_BUILD_NAME_LEN);
    // Out-of-range index is a no-op.
    get().setBuildName(9, "nope");
    assert.strictEqual(get().buildNames.length, 1);
  });

  test("removeBuild drops the matching name", async () => {
    const [a, b] = genStrings("death_knight", "blood", 2);
    await get().addBuild(a);
    await get().addBuild(b);
    get().setBuildName(0, "first");
    get().setBuildName(1, "second");
    get().removeBuild(0);
    assert.deepStrictEqual(get().buildNames, ["second"]);
  });

  test("setBuildNames normalises to the current build count", async () => {
    const [a, b] = genStrings("death_knight", "blood", 2);
    await get().addBuild(a);
    await get().addBuild(b);
    // Too few → padded with ''; extras ignored; non-strings coerced to ''.
    get().setBuildNames(["only one"]);
    assert.deepStrictEqual(get().buildNames, ["only one", ""]);
    get().setBuildNames(["a", "b", "c"]);
    assert.deepStrictEqual(get().buildNames, ["a", "b"]);
  });

  test("clearing the last build resets names", async () => {
    const [a] = genStrings("death_knight", "blood", 1);
    await get().addBuild(a);
    get().setBuildName(0, "name");
    get().removeBuild(0);
    assert.deepStrictEqual(get().buildNames, []);
  });
});

// ── Hero-subtree sanitisation ─────────────────────────────────────────────────

describe("setInteractiveNodes", () => {
  test("strips all but the dominant hero subtree", async () => {
    await get().preloadSpec(DK_BLOOD);
    const td = get().treeData;
    const hero = td.nodes.filter(
      (n) => n.treeType === "hero" && !n.alreadyGranted,
    );
    const leftName = td.heroSubtrees.left.name;
    const rightName = td.heroSubtrees.right.name;
    const leftNode = hero.find((n) => n.heroSubtree === leftName);
    const rightNodes = hero
      .filter((n) => n.heroSubtree === rightName)
      .slice(0, 2);
    assert.ok(
      leftNode && rightNodes.length >= 2,
      "fixture needs hero nodes in both subtrees",
    );

    // Left = 1 point, Right = 2 points → Right dominates, Left should be stripped.
    const sel = { ...get().interactiveNodes };
    sel[leftNode.id] = { pointsInvested: 1, entryChosen: null };
    for (const rn of rightNodes)
      sel[rn.id] = { pointsInvested: 1, entryChosen: null };
    get().setInteractiveNodes(sel);

    const after = get().interactiveNodes;
    assert.ok(!after[leftNode.id], "weaker subtree node should be removed");
    for (const rn of rightNodes)
      assert.ok(after[rn.id], "dominant subtree nodes should be kept");
  });

  test("leaves a single active subtree untouched", async () => {
    await get().preloadSpec(DK_BLOOD);
    const td = get().treeData;
    const leftName = td.heroSubtrees.left.name;
    const leftNode = td.nodes.find(
      (n) =>
        n.treeType === "hero" &&
        !n.alreadyGranted &&
        n.heroSubtree === leftName,
    );
    const sel = {
      ...get().interactiveNodes,
      [leftNode.id]: { pointsInvested: 1, entryChosen: null },
    };
    get().setInteractiveNodes(sel);
    assert.ok(
      get().interactiveNodes[leftNode.id],
      "lone active subtree should be preserved",
    );
  });
});

// ── Edit and replace ──────────────────────────────────────────────────────────

describe("editBuild and replaceBuild", () => {
  test("editBuild seeds from parsed nodes and sets editingIndex", async () => {
    const [a] = genStrings("death_knight", "blood", 1);
    await get().addBuild(a);
    get().editBuild(0);
    assert.strictEqual(get().addingBuild, true);
    assert.strictEqual(get().editingIndex, 0);
    assert.ok(Object.keys(get().interactiveNodes).length > 0);
  });

  test("replaceBuild swaps string, re-parses, keeps name, and rejects mismatches/duplicates", async () => {
    const [a, b, c] = genStrings("death_knight", "blood", 3);
    const [mage] = genStrings("mage", "fire", 1);
    await get().addBuild(a);
    await get().addBuild(b);
    get().setBuildName(0, "First Slot");

    // Replace slot 0 with c
    await get().replaceBuild(0, c);
    assert.strictEqual(get().buildStrings[0], c);
    assert.strictEqual(get().buildNames[0], "First Slot");
    assert.ok(get().parsedBuilds[0]);

    // Reject duplicate of slot 1 (b)
    await get().replaceBuild(0, b);
    assert.match(get().error ?? "", /already been added/);
    assert.strictEqual(get().buildStrings[0], c);

    // Reject spec mismatch (mage)
    await get().replaceBuild(0, mage);
    assert.match(get().error ?? "", /Spec mismatch/);
    assert.strictEqual(get().buildStrings[0], c);
  });

  test("replaceBuild skips when a remove reindexes the slots first", async () => {
    const [a, b, c] = genStrings("death_knight", "blood", 3);
    await get().addBuild(a);
    await get().addBuild(b);

    // Queue a replace of slot 1, then synchronously remove slot 0 before the
    // queued replace runs. The captured index 1 is now stale (it would land on
    // the wrong build), so the replace must be skipped.
    const pending = get().replaceBuild(1, c);
    get().removeBuild(0);
    const ok = await pending;

    assert.strictEqual(ok, false, "stale replace resolves falsy");
    assert.deepStrictEqual(
      get().buildStrings,
      [b],
      "only build a was removed; b is untouched by the stale replace",
    );
  });

  test("addBuild and replaceBuild resolve truthy on success, falsy on rejection", async () => {
    const [a, b, c] = genStrings("death_knight", "blood", 3);

    // addBuild: truthy when committed, falsy when rejected as a duplicate.
    assert.ok(await get().addBuild(a), "first add should succeed");
    assert.ok(await get().addBuild(b), "second add should succeed");
    assert.ok(!(await get().addBuild(a)), "duplicate add should be rejected");

    // replaceBuild: truthy on a real swap, falsy when the result duplicates a slot.
    assert.ok(await get().replaceBuild(0, c), "valid replace should succeed");
    assert.ok(
      !(await get().replaceBuild(0, b)),
      "replace into a duplicate should be rejected",
    );
  });
});

// ── layoutHash ────────────────────────────────────────────────────────────────

describe("layoutHash tracking", () => {
  test("computes layoutHash on spec load and supports setSharedLayoutHash", async () => {
    const [a] = genStrings("death_knight", "blood", 1);
    await get().addBuild(a);
    const st = get();
    assert.ok(st.layoutHash, "layoutHash should be set on load");
    // The stamp is the class-level wire-layout fingerprint (16 hex chars), not a
    // per-spec hash, so it also moves when a sibling spec shifts the bit layout.
    assert.strictEqual(st.layoutHash.length, 16);
    assert.strictEqual(
      st.layoutHash,
      wireLayout(require("../data/death_knight.json")).hash,
    );

    get().setSharedLayoutHash("oldhash1");
    assert.strictEqual(get().sharedLayoutHash, "oldhash1");
  });
});

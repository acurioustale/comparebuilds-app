/**
 * Round-trip tests for the build-string parser/encoder.
 *
 * Run:  npm test   (or: npx vitest run src/lib/buildString.test.js)
 *
 * These guard the most dangerous failure mode of a data change: a build string
 * that silently misparses because the serialisation node set drifted. For every
 * implemented class+spec we:
 *   1. construct a deterministic selection (full and partial),
 *   2. encode it with generateBuildString,
 *   3. parse it back with parseBuildString,
 *   4. assert the round-trip is exact (header + every node's points & choice).
 *
 * Because encode and decode both derive their node order from collectClassNodes,
 * a self-consistent round-trip proves the encoder, decoder, partial-rank path,
 * choice path, and apex path all agree on the bit layout. The wire-layout
 * snapshot test (dataIntegrity.test.js) covers drift of that layout itself.
 */

import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  parseBuildString,
  generateBuildString,
  parseSpecId,
  collectClassNodes,
  heroGateSelection,
} from "./buildString.js";

const require = createRequire(import.meta.url);
const classIndex = require("../data/classes.json");

// ── Selection builders ────────────────────────────────────────────────────────

/** Every non-granted spec node selected at full rank; choice nodes pick option 0. */
function fullSelection(specNodes) {
  const sel = {};
  for (const n of specNodes) {
    if (n.alreadyGranted) continue;
    sel[n.id] = {
      pointsInvested:
        n.type === "choice" ? (n.choices?.[0]?.maxRanks ?? 1) : n.maxRanks,
      entryChosen: n.type === "choice" ? 0 : null,
    };
  }
  return sel;
}

/**
 * A varied selection that exercises every code path:
 *   - multi-rank nodes at a PARTIAL rank (isPartiallyRanked branch)
 *   - choice nodes on their SECOND option (entryChosen = 1)
 *   - single-rank nodes fully purchased
 */
function variedSelection(specNodes) {
  const sel = {};
  for (const n of specNodes) {
    if (n.alreadyGranted) continue;
    if (n.type === "choice") {
      const opt = (n.choices?.length ?? 1) > 1 ? 1 : 0;
      sel[n.id] = {
        pointsInvested: n.choices?.[opt]?.maxRanks ?? 1,
        entryChosen: opt,
      };
    } else if (n.maxRanks > 1) {
      sel[n.id] = { pointsInvested: 1, entryChosen: null }; // partial: 1 of >1
    } else {
      sel[n.id] = { pointsInvested: 1, entryChosen: null };
    }
  }
  return sel;
}

/** Asserts two selection maps are exactly equal. */
function assertSameSelection(actual, expected, label) {
  const aIds = Object.keys(actual)
    .map(Number)
    .sort((x, y) => x - y);
  const eIds = Object.keys(expected)
    .map(Number)
    .sort((x, y) => x - y);
  assert.deepStrictEqual(aIds, eIds, `${label}: selected node IDs differ`);
  for (const id of eIds) {
    assert.strictEqual(
      actual[id].pointsInvested,
      expected[id].pointsInvested,
      `${label}: node ${id} pointsInvested mismatch`,
    );
    assert.strictEqual(
      actual[id].entryChosen ?? null,
      expected[id].entryChosen ?? null,
      `${label}: node ${id} entryChosen mismatch`,
    );
  }
}

// ── Per-class round-trip ──────────────────────────────────────────────────────

for (const cls of classIndex.filter((c) => c.implemented)) {
  const data = require(`../data/${cls.name}.json`);
  const classNodes = collectClassNodes(data);

  test("collectClassNodes is strictly ascending and unique", () => {
    for (let i = 1; i < classNodes.length; i++) {
      assert.ok(
        classNodes[i].id > classNodes[i - 1].id,
        `node order not strictly ascending at index ${i}`,
      );
    }
  });

  for (const slug of Object.keys(data.specs)) {
    const spec = data.specs[slug];
    const specNodes = spec.nodes;

    test(`${slug}: full selection round-trips`, () => {
      const sel = fullSelection(specNodes);
      const str = generateBuildString(sel, spec.specId, classNodes);
      const parsed = parseBuildString(str, classNodes);
      assert.strictEqual(parsed.specId, spec.specId, "specId mismatch");
      assertSameSelection(parsed.nodes, sel, `${slug} full`);
    });

    test(`${slug}: varied (partial ranks + 2nd choices) round-trips`, () => {
      const sel = variedSelection(specNodes);
      const str = generateBuildString(sel, spec.specId, classNodes);
      const parsed = parseBuildString(str, classNodes);
      assert.strictEqual(parsed.specId, spec.specId, "specId mismatch");
      assertSameSelection(parsed.nodes, sel, `${slug} varied`);
    });

    test(`${slug}: parseSpecId reads the header from a generated string`, () => {
      const str = generateBuildString(
        fullSelection(specNodes),
        spec.specId,
        classNodes,
      );
      const { specId, version } = parseSpecId(str);
      assert.strictEqual(specId, spec.specId, "header specId mismatch");
      assert.ok(Number.isInteger(version), "version should be an integer");
    });

    test(`${slug}: empty selection round-trips to nothing`, () => {
      const str = generateBuildString({}, spec.specId, classNodes);
      const parsed = parseBuildString(str, classNodes);
      assert.strictEqual(parsed.specId, spec.specId);
      assert.strictEqual(
        Object.keys(parsed.nodes).length,
        0,
        "expected no selected nodes",
      );
    });
  }
}

// ── Error paths ───────────────────────────────────────────────────────────────
// A truncated or corrupt string must fail loudly, never return garbage — the
// store relies on these throws to mark a build as "failed to parse".

describe("error handling", () => {
  const TINY = [{ id: 1, maxRanks: 1, choices: null }];

  test("parseBuildString rejects a non-string", () => {
    assert.throws(() => parseBuildString(null, TINY), TypeError);
    assert.throws(() => parseBuildString("", TINY), /non-empty string/);
  });

  test("parseBuildString rejects an empty / non-array node list", () => {
    assert.throws(() => parseBuildString("AAAAAAAA", []), /non-empty array/);
    assert.throws(() => parseBuildString("AAAAAAAA", null), /non-empty array/);
  });

  test("parseBuildString throws on an invalid base64 character", () => {
    assert.throws(() => parseBuildString("@@@@@@", TINY), /Invalid character/);
  });

  test("parseBuildString throws when the stream is exhausted (truncated)", () => {
    // 'CA' = a valid v2 version byte (so it passes the version gate) but only
    // 12 bits total, while the header needs 24 — runs out mid-header.
    assert.throws(() => parseBuildString("CA", TINY), /exhausted/);
  });

  test("parseBuildString rejects an unsupported serialisation version", () => {
    // 'AA' decodes to version 0; only version 2 is supported.
    assert.throws(
      () => parseBuildString("AAAAAAAA", TINY),
      /Unsupported build string version 0/,
    );
  });

  test("parseSpecId rejects an unsupported serialisation version", () => {
    assert.throws(
      () => parseSpecId("AAAAAAAA"),
      /Unsupported build string version 0/,
    );
  });

  test("parseSpecId rejects a non-string", () => {
    assert.throws(() => parseSpecId(undefined), /non-empty string/);
  });

  test("parseSpecId throws when too short for the 24-bit header", () => {
    assert.throws(() => parseSpecId("A"), /exhausted/);
  });

  test("a generated string survives padding being stripped", () => {
    // BitReader strips trailing "=" — make sure a padded string still parses.
    const data = require("../data/death_knight.json");
    const nodes = collectClassNodes(data);
    const str = generateBuildString({}, data.specs.blood.specId, nodes);
    assert.strictEqual(parseSpecId(str + "==").specId, data.specs.blood.specId);
  });

  test("choice node with a null entryChosen round-trips its rank", () => {
    // node.maxRanks (1) differs from the chosen option's maxRanks (3). A null
    // entryChosen must resolve maxRanks via the written index (0), so the partial
    // flag agrees with decode and pointsInvested is preserved rather than snapping
    // to the option's full rank.
    const nodes = [
      { id: 1, maxRanks: 1, choices: [{ maxRanks: 3 }, { maxRanks: 3 }] },
    ];
    const str = generateBuildString(
      { 1: { pointsInvested: 2, entryChosen: null } },
      250,
      nodes,
    );
    const parsed = parseBuildString(str, nodes);
    assert.strictEqual(parsed.nodes[1].pointsInvested, 2);
    assert.strictEqual(parsed.nodes[1].entryChosen, 0);
  });
});

// ── Hardening against corrupt input ───────────────────────────────────────────

describe("parseBuildString clamps an over-max partial rank", () => {
  const CHARSET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  // LSB-first bit packing, mirroring the encoder, so we can hand-craft a stream
  // the encoder itself would never emit (a partial rank above the node's max).
  const pushInt = (bits, value, count) => {
    for (let i = 0; i < count; i++) bits.push((value >> i) & 1);
  };
  const bitsToStr = (bits) => {
    const b = [...bits];
    while (b.length % 6 !== 0) b.push(0);
    let out = "";
    for (let i = 0; i < b.length; i += 6) {
      let v = 0;
      for (let j = 0; j < 6; j++) v |= b[i + j] << j;
      out += CHARSET[v];
    }
    return out;
  };

  test("a partial value beyond maxRanks is capped to the node max", () => {
    const bits = [];
    pushInt(bits, 2, 8); // version
    pushInt(bits, 250, 16); // specId
    for (let i = 0; i < 128; i++) bits.push(0); // hash
    // One node (id 100, maxRanks 5): selected, purchased, partially-ranked with a
    // corrupt rank of 63, non-choice.
    bits.push(1, 1, 1);
    pushInt(bits, 63, 6);
    bits.push(0);

    const parsed = parseBuildString(bitsToStr(bits), [
      { id: 100, maxRanks: 5, choices: null },
    ]);
    assert.strictEqual(parsed.nodes[100].pointsInvested, 5);
  });

  test("an out-of-range choice index is clamped into a real option", () => {
    const bits = [];
    pushInt(bits, 2, 8); // version
    pushInt(bits, 250, 16); // specId
    for (let i = 0; i < 128; i++) bits.push(0); // hash
    // One 2-option choice node (id 100): selected, purchased, not partially
    // ranked, choice node with a corrupt entryChosen of 3 (only 0/1 are valid).
    bits.push(1, 1, 0, 1);
    pushInt(bits, 3, 2);

    const parsed = parseBuildString(bitsToStr(bits), [
      { id: 100, maxRanks: 1, choices: [{ maxRanks: 1 }, { maxRanks: 1 }] },
    ]);
    // Clamped to the last valid index so it can't index past choices[].
    assert.strictEqual(parsed.nodes[100].entryChosen, 1);
  });

  test("a choice bit on a non-choice node yields entryChosen null", () => {
    const bits = [];
    pushInt(bits, 2, 8); // version
    pushInt(bits, 250, 16); // specId
    for (let i = 0; i < 128; i++) bits.push(0); // hash
    // One non-choice node (id 100, choices: null): selected, purchased, not
    // partially ranked, but the stream nonetheless sets the isChoiceNode bit and
    // a 2-bit index — what a hand-crafted string or a version skew could carry.
    bits.push(1, 1, 0, 1);
    pushInt(bits, 1, 2);

    const parsed = parseBuildString(bitsToStr(bits), [
      { id: 100, maxRanks: 1, choices: null },
    ]);
    // The node has no choices, so entryChosen must be null per the contract — not
    // the stray index the bitstream carried, which diff/heatmap would otherwise
    // read as a difference.
    assert.strictEqual(parsed.nodes[100].pointsInvested, 1);
    assert.strictEqual(parsed.nodes[100].entryChosen, null);
  });

  test("a partially-ranked value of 0 drops the node entirely", () => {
    const bits = [];
    pushInt(bits, 2, 8); // version
    pushInt(bits, 250, 16); // specId
    for (let i = 0; i < 128; i++) bits.push(0); // hash
    // One node (id 100, maxRanks 5): selected, purchased, partially-ranked with a
    // nonsensical rank of 0, non-choice.
    bits.push(1, 1, 1);
    pushInt(bits, 0, 6);
    bits.push(0);

    const parsed = parseBuildString(bitsToStr(bits), [
      { id: 100, maxRanks: 5, choices: null },
    ]);
    // A purchased-but-zero node is corrupt; it must not appear as selected.
    assert.strictEqual(parsed.nodes[100], undefined);
  });
});

describe("heroGateSelection", () => {
  test("returns null when no hero points are invested", () => {
    assert.strictEqual(heroGateSelection(0, false), null);
    assert.strictEqual(heroGateSelection(0, true), null);
  });

  test("encodes the active subtree as entryChosen (0 = left, 1 = right)", () => {
    assert.deepStrictEqual(heroGateSelection(3, false), {
      pointsInvested: 1,
      entryChosen: 0,
    });
    assert.deepStrictEqual(heroGateSelection(5, true), {
      pointsInvested: 1,
      entryChosen: 1,
    });
  });
});

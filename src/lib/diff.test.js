/**
 * Tests for the build-diff logic extracted from SideBySideDiff.
 */

import { describe, test } from "vitest";
import assert from "node:assert/strict";
import {
  computeDiff,
  differenceLabel,
  groupBySection,
  selectionLabel,
} from "./diff.js";

// Small synthetic spec: one class node, a multi-rank spec node, a choice node,
// a hero node, and an always-granted node.
const NODES = [
  {
    id: 1,
    treeType: "class",
    type: "round",
    posX: 0,
    posY: 0,
    maxRanks: 1,
    name: "Class A",
    alreadyGranted: false,
  },
  {
    id: 2,
    treeType: "spec",
    type: "round",
    posX: 0,
    posY: 1,
    maxRanks: 3,
    name: "Spec B",
    alreadyGranted: false,
  },
  {
    id: 3,
    treeType: "spec",
    type: "choice",
    posX: 1,
    posY: 1,
    maxRanks: 1,
    name: null,
    alreadyGranted: false,
    choices: [{ name: "X" }, { name: "Y" }],
  },
  {
    id: 4,
    treeType: "hero",
    type: "round",
    posX: 0,
    posY: 0,
    maxRanks: 1,
    name: "Hero H",
    alreadyGranted: false,
  },
  {
    id: 5,
    treeType: "class",
    type: "round",
    posX: 2,
    posY: 0,
    maxRanks: 1,
    name: "Granted",
    alreadyGranted: true,
  },
  {
    id: 6,
    treeType: "spec",
    type: "apex",
    posX: 1,
    posY: 9,
    maxRanks: 2,
    name: "Apex",
    alreadyGranted: false,
  },
];
const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));
const pt = (pointsInvested, entryChosen = null) => ({
  pointsInvested,
  entryChosen,
});

describe("selectionLabel", () => {
  test("null selection → null", () =>
    assert.strictEqual(selectionLabel(byId[1], null), null));
  test("single-rank node → name only", () =>
    assert.strictEqual(selectionLabel(byId[1], pt(1)), "Class A"));
  test("multi-rank node → name with ranks", () =>
    assert.strictEqual(selectionLabel(byId[2], pt(2)), "Spec B (2/3)"));
  test("apex node → name with ranks", () =>
    assert.strictEqual(selectionLabel(byId[6], pt(1)), "Apex (1/2)"));
  test("choice node → chosen option name", () =>
    assert.strictEqual(selectionLabel(byId[3], pt(1, 1)), "Y"));
  test("choice node with out-of-range index → fallback", () =>
    assert.strictEqual(selectionLabel(byId[3], pt(1, 5)), "option 6"));
  test("multi-rank chosen option → ranks against the OPTION's max, not the node's", () => {
    // node-level maxRanks (1) deliberately differs from the chosen option's (2)
    // to prove the denominator comes from the option.
    const rankedChoice = {
      type: "choice",
      name: "Split",
      maxRanks: 1,
      choices: [{ name: "X" }, { name: "Z", maxRanks: 2 }],
    };
    assert.strictEqual(selectionLabel(rankedChoice, pt(2, 1)), "Z (2/2)");
    // A single-rank option still shows just the name.
    assert.strictEqual(selectionLabel(rankedChoice, pt(1, 0)), "X");
  });
  test("choice node with unknown pick names the node, not a fake option 1", () => {
    const named = {
      type: "choice",
      name: "Capstone",
      choices: [{ name: "X" }, { name: "Y" }],
    };
    assert.strictEqual(selectionLabel(named, pt(1, null)), "Capstone");
    // The fixture's unnamed choice node yields its (null) name, never "option 1".
    assert.strictEqual(selectionLabel(byId[3], pt(1, null)), null);
  });
});

describe("computeDiff", () => {
  test("a-only and b-only are classified and highlighted", () => {
    const a = { 1: pt(1) };
    const b = { 4: pt(1) };
    const { highlights, aOnly, bOnly, differing } = computeDiff(a, b, NODES);
    assert.strictEqual(highlights[1], "a-only");
    assert.strictEqual(highlights[4], "b-only");
    assert.deepStrictEqual(
      aOnly.map((e) => e.id),
      [1],
    );
    assert.deepStrictEqual(
      bOnly.map((e) => e.id),
      [4],
    );
    assert.strictEqual(differing.length, 0);
  });

  test("differing rank is flagged as diff", () => {
    const { highlights, differing } = computeDiff(
      { 2: pt(1) },
      { 2: pt(3) },
      NODES,
    );
    assert.strictEqual(highlights[2], "diff");
    assert.deepStrictEqual(
      differing.map((e) => e.id),
      [2],
    );
  });

  test("differing choice is flagged as diff", () => {
    const { highlights, differing } = computeDiff(
      { 3: pt(1, 0) },
      { 3: pt(1, 1) },
      NODES,
    );
    assert.strictEqual(highlights[3], "diff");
    assert.deepStrictEqual(
      differing.map((e) => e.id),
      [3],
    );
  });

  test("identical selections produce no diff", () => {
    const sel = { 1: pt(1), 2: pt(3) };
    const { aOnly, bOnly, differing } = computeDiff(sel, { ...sel }, NODES);
    assert.strictEqual(aOnly.length + bOnly.length + differing.length, 0);
  });

  test("alreadyGranted nodes are never diffed", () => {
    const { highlights, aOnly } = computeDiff({ 5: pt(1) }, {}, NODES);
    assert.strictEqual(highlights[5], undefined);
    assert.strictEqual(aOnly.length, 0);
  });

  test("ids absent from the node list are ignored", () => {
    const { aOnly } = computeDiff({ 999: pt(1) }, {}, NODES);
    assert.strictEqual(aOnly.length, 0);
  });

  test("entries are sorted class → spec → hero", () => {
    // 4 = hero, 1 = class, 2 = spec — all a-only; expect class, spec, hero order
    const { aOnly } = computeDiff({ 1: pt(1), 2: pt(3), 4: pt(1) }, {}, NODES);
    assert.deepStrictEqual(
      aOnly.map((e) => e.node.treeType),
      ["class", "spec", "hero"],
    );
  });
});

describe("groupBySection", () => {
  test("buckets entries by treeType in class → spec → hero order", () => {
    const entries = [
      { id: 4, node: byId[4] }, // hero
      { id: 1, node: byId[1] }, // class
      { id: 2, node: byId[2] }, // spec
    ];
    const groups = groupBySection(entries);
    assert.deepStrictEqual(
      groups.map((g) => g.section),
      ["class", "spec", "hero"],
    );
    assert.deepStrictEqual(
      groups.map((g) => g.label),
      ["Class", "Spec", "Hero"],
    );
    assert.deepStrictEqual(
      groups.map((g) => g.entries.map((e) => e.id)),
      [[1], [2], [4]],
    );
  });

  test("drops sections with no entries", () => {
    const groups = groupBySection([{ id: 1, node: byId[1] }]);
    assert.deepStrictEqual(
      groups.map((g) => g.section),
      ["class"],
    );
  });

  test("preserves input order within a section", () => {
    const groups = groupBySection([
      { id: 2, node: byId[2] },
      { id: 3, node: byId[3] },
    ]);
    assert.deepStrictEqual(
      groups[0].entries.map((e) => e.id),
      [2, 3],
    );
  });

  test("empty input yields no groups", () => {
    assert.deepStrictEqual(groupBySection([]), []);
  });

  test("drops entries with an unrecognised or missing treeType", () => {
    const groups = groupBySection([
      { id: 1, node: byId[1] },
      { id: 99, node: { treeType: "unknown" } },
      { id: 100, node: {} },
    ]);
    assert.deepStrictEqual(
      groups.map((g) => g.entries.map((e) => e.id)),
      [[1]],
    );
  });
});

describe("differenceLabel", () => {
  test("choice node both builds took, different picks → 'X → Y'", () => {
    assert.strictEqual(differenceLabel(byId[3], pt(1, 0), pt(1, 1)), "X → Y");
  });

  test("choice node both builds took, same pick → null", () => {
    assert.strictEqual(differenceLabel(byId[3], pt(1, 0), pt(1, 0)), null);
  });

  test("choice node present in A, absent in B → 'dropped'", () => {
    assert.strictEqual(differenceLabel(byId[3], pt(1, 0), null), "dropped");
  });

  test("choice node absent in A, present in B → 'gained'", () => {
    assert.strictEqual(differenceLabel(byId[3], null, pt(1, 1)), "gained");
  });

  test("apex node present in A, absent in B → 'dropped'", () => {
    assert.strictEqual(differenceLabel(byId[6], pt(2), null), "dropped");
  });

  test("apex node absent in A, present in B → 'gained'", () => {
    assert.strictEqual(differenceLabel(byId[6], null, pt(1)), "gained");
  });

  test("apex node in both (rank-only change) → null", () => {
    assert.strictEqual(differenceLabel(byId[6], pt(1), pt(2)), null);
  });

  test("non-choice, non-apex node → null regardless of selections", () => {
    assert.strictEqual(differenceLabel(byId[2], pt(1), null), null);
    assert.strictEqual(differenceLabel(byId[2], pt(1), pt(3)), null);
  });
});

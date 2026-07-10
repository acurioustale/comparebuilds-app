/**
 * Tests for the interactive spend rules extracted from InteractiveTalentTree.
 * canSpendPoint integrates the real gate/prereq helpers from treeLogic.
 */

import { describe, test } from "vitest";
import assert from "node:assert/strict";
import {
  sectionPoints,
  heroSubtreePoints,
  activeHeroSubtree,
  canSpendPoint,
  prunedExportSelection,
} from "./spendRules.js";

function node(id, treeType, posY, opts = {}) {
  return {
    id,
    treeType,
    posY,
    posX: opts.posX ?? 0,
    maxRanks: opts.maxRanks ?? 1,
    spentRequired: opts.spentRequired ?? 0,
    connections: opts.connections ?? [],
    alreadyGranted: opts.alreadyGranted ?? false,
    heroSubtree: opts.heroSubtree,
  };
}

const ROOT = node(1, "class", 0);
const CHILD = node(2, "class", 1, { connections: [1] });
const GATED = node(3, "class", 1, {
  posX: 1,
  spentRequired: 5,
  connections: [1],
});
const GRANTED = node(4, "class", 0, { posX: 2, alreadyGranted: true });
const HERO_L = node(10, "hero", 0, { heroSubtree: "Left" });
const HERO_R = node(11, "hero", 0, { heroSubtree: "Right" });

const ALL = [ROOT, CHILD, GATED, GRANTED, HERO_L, HERO_R];
const byId = Object.fromEntries(ALL.map((n) => [n.id, n]));
const pt = (pointsInvested = 1) => ({ pointsInvested, entryChosen: null });
const BUDGET = { class: 10, spec: 10, hero: 10 };

describe("sectionPoints", () => {
  test("sums a section, excluding granted nodes", () => {
    const selected = { 1: pt(), 2: pt(), 4: pt() }; // 4 is granted
    assert.strictEqual(sectionPoints("class", ALL, selected), 2);
  });
  test("returns 0 for an empty section", () => {
    assert.strictEqual(sectionPoints("hero", ALL, {}), 0);
  });
});

describe("heroSubtreePoints", () => {
  test("sums only the named subtree, ignoring the other", () => {
    // Corrupt dual-subtree selection: Left has 1, Right has 1.
    const selected = { 10: pt(), 11: pt() };
    assert.strictEqual(heroSubtreePoints(ALL, selected, "Left"), 1);
    assert.strictEqual(heroSubtreePoints(ALL, selected, "Right"), 1);
  });
  test("returns 0 for a null subtree or one with no spend", () => {
    assert.strictEqual(heroSubtreePoints(ALL, { 10: pt() }, null), 0);
    assert.strictEqual(heroSubtreePoints(ALL, { 1: pt() }, "Left"), 0);
  });
});

describe("activeHeroSubtree", () => {
  test("returns the first selected non-granted hero subtree", () => {
    assert.strictEqual(activeHeroSubtree(ALL, { 11: pt() }), "Right");
  });
  test("returns null when no hero node is selected", () => {
    assert.strictEqual(activeHeroSubtree(ALL, { 1: pt() }), null);
  });
  test("a zero-point entry does not commit a subtree", () => {
    // Regression: a corrupt/legacy persisted {pointsInvested: 0} entry (the
    // in-app refund path deletes entries at zero; rehydration filters unknown
    // ids but not zero-point ranks) used to count as commitment — locking the
    // other subtree, flagging its picks invalid, and skipping the export's
    // hero gate with zero visible hero points spent.
    assert.strictEqual(activeHeroSubtree(ALL, { 10: pt(0) }), null);
    // …and doesn't shadow a genuinely committed later subtree either.
    assert.strictEqual(
      activeHeroSubtree(ALL, { 10: pt(0), 11: pt() }),
      "Right",
    );
  });
});

describe("canSpendPoint", () => {
  test("granted nodes can never be spent on", () => {
    assert.strictEqual(canSpendPoint(GRANTED, ALL, {}, byId, BUDGET), false);
  });

  test("blocked when the upper prerequisite is unmet", () => {
    assert.strictEqual(canSpendPoint(CHILD, ALL, {}, byId, BUDGET), false);
  });

  test("allowed once the prerequisite is satisfied", () => {
    assert.strictEqual(
      canSpendPoint(CHILD, ALL, { 1: pt() }, byId, BUDGET),
      true,
    );
  });

  test("blocked when the section budget is exhausted", () => {
    // prereq met (root full) but class budget of 1 already spent on the root
    assert.strictEqual(
      canSpendPoint(CHILD, ALL, { 1: pt() }, byId, { ...BUDGET, class: 1 }),
      false,
    );
  });

  test("blocked when the gate threshold is not met", () => {
    // GATED needs 5 points in the section; only 1 is spent
    assert.strictEqual(
      canSpendPoint(GATED, ALL, { 1: pt() }, byId, BUDGET),
      false,
    );
  });

  test("allowed when the gate threshold is met", () => {
    const lowGate = node(3, "class", 1, {
      posX: 1,
      spentRequired: 1,
      connections: [1],
    });
    const all = [ROOT, lowGate];
    const ids = Object.fromEntries(all.map((n) => [n.id, n]));
    assert.strictEqual(
      canSpendPoint(lowGate, all, { 1: pt() }, ids, BUDGET),
      true,
    );
  });

  test("hero subtree exclusivity blocks the other subtree", () => {
    // Left is active; spending on a Right node is blocked
    assert.strictEqual(
      canSpendPoint(HERO_R, ALL, { 10: pt() }, byId, BUDGET),
      false,
    );
  });

  test("first hero node of either subtree is allowed", () => {
    assert.strictEqual(canSpendPoint(HERO_R, ALL, {}, byId, BUDGET), true);
  });

  test("hero budget scopes to the active subtree, not the whole section", () => {
    // Corrupt dual-subtree selection: Left (active) has 1 point, Right has 1.
    // With a per-subtree hero budget of 2, the whole-section total (2) already
    // equals the budget, but the active subtree still has room — spending
    // another Left node must be allowed, not blocked by the inactive subtree's
    // parked point.
    const HERO_L2 = node(12, "hero", 1, {
      heroSubtree: "Left",
      connections: [10],
    });
    const all = [HERO_L, HERO_R, HERO_L2];
    const ids = Object.fromEntries(all.map((n) => [n.id, n]));
    const dual = { 10: pt(), 11: pt() }; // Left active, Right parked
    assert.strictEqual(
      canSpendPoint(HERO_L2, all, dual, ids, { ...BUDGET, hero: 2 }),
      true,
    );
  });

  test("co-located node is blocked when its cell is already taken", () => {
    // Two non-granted class nodes sharing one grid cell (same posX,posY).
    const A = node(40, "class", 0, { posX: 5 });
    const B = node(41, "class", 0, { posX: 5 });
    const all = [A, B];
    const ids = Object.fromEntries(all.map((n) => [n.id, n]));
    // A already taken → B (same cell) is refused despite budget/prereq being fine.
    assert.strictEqual(canSpendPoint(B, all, { 40: pt() }, ids, BUDGET), false);
    // Empty cell → A is allowed.
    assert.strictEqual(canSpendPoint(A, all, {}, ids, BUDGET), true);
  });
});

describe("prunedExportSelection", () => {
  // Both hero subtrees have an auto-granted root (seeded by buildGrantedSeed).
  const GRANTED_L = node(100, "hero", 0, {
    heroSubtree: "Left",
    alreadyGranted: true,
  });
  const GRANTED_R = node(101, "hero", 0, {
    heroSubtree: "Right",
    alreadyGranted: true,
  });
  const NODES = [ROOT, GRANTED, HERO_L, HERO_R, GRANTED_L, GRANTED_R];
  const full = () => ({ pointsInvested: 1, entryChosen: null });
  // A typical interactive selection: granted seed (class grant + both hero roots)
  // plus a purchased Left hero node.
  const selected = {
    1: full(), // purchased class node
    4: full(), // class grant (GRANTED)
    100: full(), // Left hero root (granted)
    101: full(), // Right hero root (granted)
    10: full(), // purchased Left hero node
  };

  test("drops the inactive hero subtree's granted root, keeps the active one", () => {
    const out = prunedExportSelection(NODES, selected, "Left");
    assert.ok(out[100], "active-subtree granted root kept");
    assert.strictEqual(out[101], undefined, "inactive granted root removed");
  });

  test("keeps class/spec grants and purchased nodes untouched", () => {
    const out = prunedExportSelection(NODES, selected, "Left");
    assert.ok(out[4], "class grant kept");
    assert.ok(out[1], "purchased class node kept");
    assert.ok(out[10], "purchased hero node kept");
  });

  test("drops purchased picks in the inactive subtree (dual-subtree import)", () => {
    // A corrupt/tool-built import (or an editBuild seed) can carry purchased
    // picks in BOTH hero subtrees. Only the active subtree may survive; a
    // surviving inactive pick would encode points in two hero subtrees at once —
    // an impossible build.
    const dual = {
      1: full(),
      100: full(), // Left granted root
      101: full(), // Right granted root
      10: full(), // purchased Left hero node (active)
      11: full(), // purchased Right hero node (inactive) — must be dropped
    };
    const out = prunedExportSelection(NODES, dual, "Left");
    assert.ok(out[10], "active-subtree purchased pick kept");
    assert.strictEqual(
      out[11],
      undefined,
      "inactive-subtree purchased pick removed",
    );
    assert.strictEqual(out[101], undefined, "inactive granted root removed");
  });

  test("with no active subtree, prunes every granted hero root", () => {
    const out = prunedExportSelection(NODES, selected, null);
    assert.strictEqual(out[100], undefined);
    assert.strictEqual(out[101], undefined);
    assert.ok(out[4], "non-hero grant still kept");
  });

  test("does not mutate the input selection", () => {
    const snapshot = { ...selected };
    prunedExportSelection(NODES, selected, "Left");
    assert.deepStrictEqual(selected, snapshot);
  });

  test("collapses a co-located cell to its lowest-id node", () => {
    // Two non-granted class nodes sharing one cell (duplicate records for one
    // talent). A tool-built import can set both; the export keeps only the lowest.
    const A = node(40, "class", 0, { posX: 5 });
    const B = node(41, "class", 0, { posX: 5 });
    const nodes = [A, B];
    const out = prunedExportSelection(nodes, { 40: full(), 41: full() }, null);
    assert.ok(out[40], "lowest-id node kept");
    assert.strictEqual(out[41], undefined, "higher-id duplicate dropped");
  });

  test("drops selected ids that aren't real nodes in the spec tree", () => {
    // A tool string can set a bit the ingest collapsed into unusedNodeIds (no
    // longer a real spec node), and a seeded edit can carry the hero-gate id.
    // Neither should encode as a purchased node, so they self-heal out on export.
    const out = prunedExportSelection(
      NODES,
      { 1: full(), 999999: full() },
      "Left",
    );
    assert.ok(out[1], "real node kept");
    assert.strictEqual(out[999999], undefined, "unknown id dropped");
  });
});

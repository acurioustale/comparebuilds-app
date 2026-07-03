/**
 * Verification tests for computeInvalidNodeIds.
 *
 * Run:  npm test   (or: npx vitest run src/lib/treeLogic.test.js)
 *
 * Assertions use Node's built-in assert module inside Vitest's test runner.
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  computeInvalidNodeIds,
  cellKey,
  spentPoints,
  gatedPoints,
  isFullySelected,
  hasUpperPrereq,
} from "./treeLogic.js";

const require = createRequire(import.meta.url);

/**
 * A canonical maximal selection: every non-granted node at full rank, but at most
 * one id per co-located cell (lowest id wins) — the game's one-id-per-slot form.
 * The real-data cascade tests below build from this rather than raw "select
 * everything" so co-located cells aren't double-counted against section budgets.
 */
function selectAllLegal(allNodes) {
  const selected = {};
  const claimed = new Set();
  // A build may invest in only one hero subtree, so commit to the one the
  // validity cascade treats as active (first non-granted hero node in node
  // order) and skip the other — otherwise hero-subtree exclusivity flags it.
  const heroSub =
    allNodes.find((n) => n.treeType === "hero" && !n.alreadyGranted)
      ?.heroSubtree ?? null;
  for (const n of [...allNodes].sort((a, b) => a.id - b.id)) {
    if (n.alreadyGranted) continue;
    if (n.treeType === "hero" && n.heroSubtree !== heroSub) continue;
    const cell = cellKey(n);
    if (claimed.has(cell)) continue;
    claimed.add(cell);
    selected[n.id] = { pointsInvested: n.maxRanks, entryChosen: null };
  }
  return selected;
}

// ─── Minimal node / selection factories ───────────────────────────────────────

/**
 * @param {number}   id
 * @param {number}   posY
 * @param {object}   [opts]
 * @param {number}   [opts.maxRanks=1]
 * @param {number}   [opts.spentRequired=0]
 * @param {number[]} [opts.connections=[]]
 * @param {string}   [opts.treeType='class']
 * @param {boolean}  [opts.alreadyGranted=false]
 */
function node(
  id,
  posY,
  {
    maxRanks = 1,
    spentRequired = 0,
    connections = [],
    treeType = "class",
    alreadyGranted = false,
  } = {},
) {
  return {
    id,
    posX: id,
    posY,
    maxRanks,
    spentRequired,
    connections,
    treeType,
    alreadyGranted,
  };
}

/** Shorthand: one selection entry at full rank */
function sel(pts = 1) {
  return { pointsInvested: pts, entryChosen: null };
}

/** Build a nodeById map from an array of nodes */
function byId(nodes) {
  const m = {};
  for (const n of nodes) m[n.id] = n;
  return m;
}

/**
 * Assert the invalid set matches exactly the given IDs (order-independent).
 */
function assertInvalid(actual, ...expectedIds) {
  const got = [...actual].sort((a, b) => a - b);
  const want = [...expectedIds].sort((a, b) => a - b);
  assert.deepStrictEqual(
    got,
    want,
    `invalid: expected [${want}] but got [${got}]`,
  );
}

// ─── Test trees ───────────────────────────────────────────────────────────────

/*
 * Linear chain
 *
 *   A(1,posY=0) ─── B(2,posY=1) ─── C(3,posY=2)
 *
 * Connections are bidirectional; posY filter determines parent/child direction.
 */
const CHAIN = [
  node(1, 0, { connections: [2] }),
  node(2, 1, { connections: [1, 3] }),
  node(3, 2, { connections: [2] }),
];

/*
 * Diamond
 *
 *        A(1,posY=0)
 *       /           \
 *   B(2,posY=1)   C(3,posY=1)
 *       \           /
 *        D(4,posY=2)
 */
const DIAMOND = [
  node(1, 0, { connections: [2, 3] }),
  node(2, 1, { connections: [1, 4] }),
  node(3, 1, { connections: [1, 4] }),
  node(4, 2, { connections: [2, 3] }),
];

/*
 * Gate tree
 *
 *   P(10,posY=0,maxRanks=2) ─── Q(11,posY=0,maxRanks=1)
 *              \                   /
 *           R(12,posY=1,spentRequired=3)
 *                     |
 *           S(13,posY=2,spentRequired=3)
 *
 * R and S each require 3 points already spent in the section.
 * With P(2)+Q(1)+R(1)+S(1)=5 points everything is valid.
 * Removing Q drops to 4 points — still above 3, so R/S remain valid.
 * Removing P drops by 2 → total falls to 3 (Q+R+S) — exactly at threshold.
 * Removing both P and Q → R's prereq also fails (both parents gone).
 */
const GATE = [
  node(10, 0, { maxRanks: 2, connections: [12] }),
  node(11, 0, { connections: [12] }),
  node(12, 1, { spentRequired: 3, connections: [10, 11, 13] }),
  node(13, 2, { spentRequired: 3, connections: [12] }),
];

// ─── Tests ────────────────────────────────────────────────────────────────────

test("nothing invalid when all selected", () => {
  const selected = { 1: sel(), 2: sel(), 3: sel() };
  assertInvalid(computeInvalidNodeIds(CHAIN, selected, byId(CHAIN)));
});

test("only direct child invalid when root removed", () => {
  // A removed; B has no valid parent, C has B as parent (still selected but invalid)
  const selected = { 2: sel(), 3: sel() };
  // Current (broken) behaviour would only flag 2; fixed code must also flag 3
  assertInvalid(computeInvalidNodeIds(CHAIN, selected, byId(CHAIN)), 2, 3);
});

test("grandchild is invalid when root removed (cascade)", () => {
  // Explicit re-statement: 3 depends on 2 which is invalid → 3 must be flagged
  const selected = { 2: sel(), 3: sel() };
  const invalid = computeInvalidNodeIds(CHAIN, selected, byId(CHAIN));
  assert.ok(invalid.has(2), "node 2 should be invalid");
  assert.ok(invalid.has(3), "node 3 should be invalid (grandchild cascade)");
});

test("re-adding the root clears all invalidity", () => {
  const selected = { 1: sel(), 2: sel(), 3: sel() };
  assertInvalid(computeInvalidNodeIds(CHAIN, selected, byId(CHAIN)));
});

test("removing middle node: child invalid, root still valid", () => {
  // A present, B removed, C has no valid parent
  const selected = { 1: sel(), 3: sel() };
  assertInvalid(computeInvalidNodeIds(CHAIN, selected, byId(CHAIN)), 3);
});

test("cascade holds when the node list is not pre-sorted (child before parent)", () => {
  // computeInvalidNodeIds sorts internally, so a caller passing nodes in a
  // non-topological order (here fully reversed: C, B, A — child before parent)
  // must still cascade. With the root A removed, both B and its grandchild C are
  // invalid; a single pass over the reversed list without the internal sort would
  // evaluate C before B was known-invalid and wrongly pass it.
  const reversed = [...CHAIN].reverse();
  const selected = { 2: sel(), 3: sel() };
  assertInvalid(
    computeInvalidNodeIds(reversed, selected, byId(reversed)),
    2,
    3,
  );
});

test("all selected → nothing invalid", () => {
  const selected = { 1: sel(), 2: sel(), 3: sel(), 4: sel() };
  assertInvalid(computeInvalidNodeIds(DIAMOND, selected, byId(DIAMOND)));
});

test("removing one branch leaves D valid via the other branch", () => {
  // B removed — D still has C as a valid parent
  const selected = { 1: sel(), 3: sel(), 4: sel() };
  assertInvalid(computeInvalidNodeIds(DIAMOND, selected, byId(DIAMOND)));
});

test("removing root A cascades to B, C, and D", () => {
  // A gone → B and C have no parent → D has only invalid parents
  const selected = { 2: sel(), 3: sel(), 4: sel() };
  assertInvalid(
    computeInvalidNodeIds(DIAMOND, selected, byId(DIAMOND)),
    2,
    3,
    4,
  );
});

test("removing A and B leaves C valid, D valid (C path survives)", () => {
  // A gone → C invalid (no parent). D: C invalid, B absent → D invalid.
  const selected = { 3: sel(), 4: sel() };
  assertInvalid(computeInvalidNodeIds(DIAMOND, selected, byId(DIAMOND)), 3, 4);
});

test("all selected at full rank → nothing invalid", () => {
  // P=2pts, Q=1pt, R=1pt, S=1pt → total=5, threshold=3 → fine
  const selected = { 10: sel(2), 11: sel(), 12: sel(), 13: sel() };
  assertInvalid(computeInvalidNodeIds(GATE, selected, byId(GATE)));
});

test("removing Q drops total to 4 — still above gate", () => {
  // P=2, R=1, S=1 → total=4 ≥ 3
  const selected = { 10: sel(2), 12: sel(), 13: sel() };
  assertInvalid(computeInvalidNodeIds(GATE, selected, byId(GATE)));
});

test("removing P drops total below gate: R and S flagged", () => {
  // Q=1, R=1, S=1 → total=3; gate=3 so exactly met → still valid
  // Let's remove Q too to drop below
  const selected = { 12: sel(), 13: sel() };
  // Total=2 < 3 → R invalid (gate); R invalid → S invalid (cascade from prereq)
  assertInvalid(computeInvalidNodeIds(GATE, selected, byId(GATE)), 12, 13);
});

test("gate violation on R cascades to S via prereq invalidity", () => {
  // Same removal: R gate-invalid → S's parent (R) is invalid → S also invalid
  const selected = { 12: sel(), 13: sel() };
  const invalid = computeInvalidNodeIds(GATE, selected, byId(GATE));
  assert.ok(invalid.has(12), "R(12) should be invalid due to gate");
  assert.ok(
    invalid.has(13),
    "S(13) should be invalid due to cascade from invalid R",
  );
});

test("decrementing P one rank keeps gate met (total still ≥ 3)", () => {
  // P=1, Q=1, R=1, S=1 → total=4 ≥ 3
  const selected = { 10: sel(1), 11: sel(), 12: sel(), 13: sel() };
  assertInvalid(computeInvalidNodeIds(GATE, selected, byId(GATE)));
});

test("a node's own point cannot satisfy its own gate", () => {
  // P=2, R=1 → raw section total is 3, which meets R's gate of 3, but R's own
  // point supplies the third. With only P's 2 points spent elsewhere you could
  // never place R (canSpendPoint blocks it), so the build is unreachable and R
  // must be flagged — counting R's own point would wrongly call it valid.
  const selected = { 10: sel(2), 12: sel() };
  assertInvalid(computeInvalidNodeIds(GATE, selected, byId(GATE)), 12);
});

test("alreadyGranted parent is always satisfied — child never invalid", () => {
  const root = node(20, 0, { alreadyGranted: true, connections: [21] });
  const child = node(21, 1, { connections: [20] });
  const nodes = [root, child];
  // Only child is in selected (root is alreadyGranted — seeded but its presence
  // in selected does not affect this check since it's filtered out)
  const selected = { 20: sel(), 21: sel() };
  assertInvalid(computeInvalidNodeIds(nodes, selected, byId(nodes)));
});

test("alreadyGranted node itself is never flagged even when selected", () => {
  const root = node(20, 0, { alreadyGranted: true });
  const nodes = [root];
  const selected = { 20: sel() };
  assertInvalid(computeInvalidNodeIds(nodes, selected, byId(nodes)));
});

test("parent at partial rank does not satisfy child prereq", () => {
  // A has maxRanks=2; B requires A to be FULLY selected (2/2)
  const twoRankRoot = node(30, 0, { maxRanks: 2, connections: [31] });
  const child = node(31, 1, { connections: [30] });
  const nodes = [twoRankRoot, child];

  // A at 1/2 → child's prereq not met → child invalid
  const selected = { 30: sel(1), 31: sel() };
  assertInvalid(computeInvalidNodeIds(nodes, selected, byId(nodes)), 31);
});

test("parent at full rank satisfies child prereq", () => {
  const twoRankRoot = node(30, 0, { maxRanks: 2, connections: [31] });
  const child = node(31, 1, { connections: [30] });
  const nodes = [twoRankRoot, child];

  const selected = { 30: sel(2), 31: sel() };
  assertInvalid(computeInvalidNodeIds(nodes, selected, byId(nodes)));
});

// ─── Co-located node exclusivity ─────────────────────────────────────────────

test("co-located cell: both variants are one talent, not a conflict", () => {
  // Two non-granted nodes occupying one grid cell (same treeType + posX,posY) are
  // duplicate records for a single talent slot (see cellKey). The game emits one,
  // but a tool-built string can set both — that is the same one-point pick, not a
  // conflict, so neither is flagged.
  const a = node(40, 0);
  const b = { ...node(41, 0), posX: a.posX };
  const nodes = [a, b];

  // Only one purchased → nothing invalid.
  assertInvalid(computeInvalidNodeIds(nodes, { 40: sel() }, byId(nodes)));
  // Both purchased → still nothing invalid, and the cell counts as one point.
  assertInvalid(
    computeInvalidNodeIds(nodes, { 40: sel(), 41: sel() }, byId(nodes)),
  );
  assert.strictEqual(spentPoints(nodes, { 40: sel(), 41: sel() }, "class"), 1);
});

test("hero-subtree exclusivity flags picks outside the committed subtree", () => {
  // A build may invest in only one hero subtree. A selection spanning both —
  // only reachable via a crafted/corrupt build string — must flag the nodes in
  // the non-active subtree so the diff/heatmap/import views can't render an
  // impossible dual-subtree build as legal.
  const left = {
    ...node(50, 0, { treeType: "hero" }),
    heroSubtree: "L",
    posX: 1,
  };
  const right = {
    ...node(51, 0, { treeType: "hero" }),
    heroSubtree: "R",
    posX: 1,
  };
  const nodes = [left, right];
  // 50 (L) is first in node order → L is active, so 51 (R) is invalid.
  assertInvalid(
    computeInvalidNodeIds(nodes, { 50: sel(), 51: sel() }, byId(nodes)),
    51,
  );
  // A single subtree is legal — nothing flagged.
  assertInvalid(computeInvalidNodeIds(nodes, { 50: sel() }, byId(nodes)));
});

test("gate ignores a co-located duplicate's double-counted point", () => {
  // A and B share one cell (1 pt each). G sits below, gated at 3 section points.
  const a = { ...node(1, 0), posX: 5 };
  const b = { ...node(2, 0), posX: 5 };
  const g = node(3, 1, { spentRequired: 3, connections: [1] });
  const nodes = [a, b, g];
  // Raw total would be 3 (A+B+G) and pass the gate, but the A/B cell counts once,
  // so the section total is 2 (cell + G): G fails its gate and is flagged. The
  // duplicate B is not itself a conflict — it is the same talent as A.
  assertInvalid(
    computeInvalidNodeIds(nodes, { 1: sel(), 2: sel(), 3: sel() }, byId(nodes)),
    3,
  );
});

test("co-located granted roots are exempt (never flagged)", () => {
  const a = { ...node(60, 0, { alreadyGranted: true }), posX: 5 };
  const b = { ...node(61, 0, { alreadyGranted: true }), posX: 5 };
  const nodes = [a, b];
  assertInvalid(
    computeInvalidNodeIds(nodes, { 60: sel(), 61: sel() }, byId(nodes)),
  );
});

// ─── Integration helper ───────────────────────────────────────────────────────

/**
 * Given a full selected-nodes map, removes the specified IDs, then returns
 * the Set of invalid node IDs under the remaining selection.
 *
 * @param {object[]} allNodes
 * @param {object}   fullySelected  Complete selection map (all non-granted nodes at maxRanks)
 * @param {...number} removeIds     IDs to remove before computing invalidity
 * @returns {Set<number>}
 */
function invalidAfterRemoving(allNodes, fullySelected, ...removeIds) {
  const nodeById = {};
  for (const n of allNodes) nodeById[n.id] = n;
  const remaining = { ...fullySelected };
  for (const id of removeIds) delete remaining[id];
  return computeInvalidNodeIds(allNodes, remaining, nodeById);
}

// ─── Feral Druid integration test ─────────────────────────────────────────────

test("removing Tiger's Fury invalidates all connection-dependent spec nodes, not class or hero", () => {
  const druid = require("../data/druid.json");
  // Feral Druid spec = specId 103, keyed as "feral" in druid.json
  const allNodes = druid.specs.feral.nodes;

  const TIGERS_FURY_ID = 82124;

  // Build a fully-selected map: every non-granted node at full rank
  const fullySelected = selectAllLegal(allNodes);

  const invalid = invalidAfterRemoving(allNodes, fullySelected, TIGERS_FURY_ID);

  // Tiger's Fury itself was removed, not selected, so it must NOT appear in invalid
  assert.ok(
    !invalid.has(TIGERS_FURY_ID),
    "Tiger's Fury was removed — should not be in invalid set",
  );

  // BFS: find all spec nodes reachable from Tiger's Fury via parent→child edges.
  // A child lists its parent in its own connections array.
  const nodeById = {};
  for (const n of allNodes) nodeById[n.id] = n;
  const childrenOf = {};
  for (const n of allNodes) {
    if (n.treeType !== "spec" || n.alreadyGranted) continue;
    for (const cid of n.connections) {
      const parent = nodeById[cid];
      if (parent && parent.posY < n.posY) {
        if (!childrenOf[parent.id]) childrenOf[parent.id] = [];
        childrenOf[parent.id].push(n.id);
      }
    }
  }
  const reachable = new Set([TIGERS_FURY_ID]);
  const queue = [TIGERS_FURY_ID];
  while (queue.length) {
    const id = queue.shift();
    for (const c of childrenOf[id] ?? []) {
      if (!reachable.has(c)) {
        reachable.add(c);
        queue.push(c);
      }
    }
  }
  // All reachable nodes except Tiger's Fury itself should be invalid after its removal
  for (const id of reachable) {
    if (id === TIGERS_FURY_ID) continue;
    assert.ok(
      invalid.has(id),
      `spec node ${id} (posY=${nodeById[id].posY}) reachable from Tiger's Fury should be invalid`,
    );
  }
  // Spec nodes that are not reachable (e.g. standalone gate-only apex nodes) should NOT be invalid
  const unreachableSpec = allNodes.filter(
    (n) => n.treeType === "spec" && !n.alreadyGranted && !reachable.has(n.id),
  );
  for (const n of unreachableSpec) {
    assert.ok(
      !invalid.has(n.id),
      `unreachable spec node ${n.id} should NOT be invalid`,
    );
  }

  // Class nodes must not be invalidated
  const classNodes = allNodes.filter(
    (n) => n.treeType === "class" && !n.alreadyGranted,
  );
  for (const n of classNodes) {
    assert.ok(!invalid.has(n.id), `class node ${n.id} should NOT be invalid`);
  }

  // Hero nodes must not be invalidated
  const heroNodes = allNodes.filter(
    (n) => n.treeType === "hero" && !n.alreadyGranted,
  );
  for (const n of heroNodes) {
    assert.ok(!invalid.has(n.id), `hero node ${n.id} should NOT be invalid`);
  }

  // Confirm the cascade depth: reachable set should contain 38 nodes (Tiger's Fury + 37 descendants)
  assert.strictEqual(
    reachable.size,
    38,
    `expected 38 reachable nodes, got ${reachable.size}`,
  );
});

// ─── Reusable spec-root cascade helper ───────────────────────────────────────

/**
 * For a given spec's node list, removes the spec root (posY=0 spec node with no
 * upper parents), then asserts:
 *   - all BFS-reachable spec children are invalid
 *   - unreachable spec nodes (standalone gate-only apex) are NOT invalid
 *   - no class or hero nodes are invalidated
 * Returns reachable set size for assertion by caller.
 */
function runSpecRootCascadeTest(allNodes, rootId) {
  const nodeById = {};
  for (const n of allNodes) nodeById[n.id] = n;

  const fullySelected = selectAllLegal(allNodes);

  const invalid = invalidAfterRemoving(allNodes, fullySelected, rootId);

  assert.ok(
    !invalid.has(rootId),
    `root ${rootId} was removed — must not appear in invalid set`,
  );

  // BFS from root through spec parent→child edges
  const childrenOf = {};
  for (const n of allNodes) {
    if (n.treeType !== "spec" || n.alreadyGranted) continue;
    for (const cid of n.connections) {
      const parent = nodeById[cid];
      if (parent && parent.posY < n.posY) {
        if (!childrenOf[parent.id]) childrenOf[parent.id] = [];
        childrenOf[parent.id].push(n.id);
      }
    }
  }
  const reachable = new Set([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift();
    for (const c of childrenOf[id] ?? []) {
      if (!reachable.has(c)) {
        reachable.add(c);
        queue.push(c);
      }
    }
  }

  for (const id of reachable) {
    if (id === rootId) continue;
    assert.ok(
      invalid.has(id),
      `spec node ${id} (posY=${nodeById[id].posY}) reachable from root ${rootId} should be invalid`,
    );
  }
  const unreachableSpec = allNodes.filter(
    (n) => n.treeType === "spec" && !n.alreadyGranted && !reachable.has(n.id),
  );
  for (const n of unreachableSpec) {
    assert.ok(
      !invalid.has(n.id),
      `unreachable spec node ${n.id} should NOT be invalid`,
    );
  }
  for (const n of allNodes.filter(
    (n) => n.treeType === "class" && !n.alreadyGranted,
  )) {
    assert.ok(!invalid.has(n.id), `class node ${n.id} should NOT be invalid`);
  }
  for (const n of allNodes.filter(
    (n) => n.treeType === "hero" && !n.alreadyGranted,
  )) {
    assert.ok(!invalid.has(n.id), `hero node ${n.id} should NOT be invalid`);
  }

  return reachable.size;
}

// ─── Warrior Protection integration test (tank) ───────────────────────────────

test("removing Ignore Pain invalidates all connection-dependent spec nodes, not class or hero", () => {
  const warrior = require("../data/warrior.json");
  const allNodes = warrior.specs.protection.nodes;
  const IGNORE_PAIN_ID = 90295;
  const reachableSize = runSpecRootCascadeTest(allNodes, IGNORE_PAIN_ID);
  assert.ok(
    reachableSize >= 2,
    `expected at least 2 reachable nodes, got ${reachableSize}`,
  );
});

// ─── Paladin Holy integration test (healer) ───────────────────────────────────

test("removing Holy Shock invalidates all connection-dependent spec nodes, not class or hero", () => {
  const paladin = require("../data/paladin.json");
  const allNodes = paladin.specs.holy.nodes;
  const HOLY_SHOCK_ID = 81555;
  const reachableSize = runSpecRootCascadeTest(allNodes, HOLY_SHOCK_ID);
  assert.ok(
    reachableSize >= 2,
    `expected at least 2 reachable nodes, got ${reachableSize}`,
  );
});

// ─── Hunter Marksmanship integration test (ranged DPS) ───────────────────────

test("removing Aimed Shot invalidates all connection-dependent spec nodes, not class or hero", () => {
  const hunter = require("../data/hunter.json");
  const allNodes = hunter.specs.marksmanship.nodes;
  const AIMED_SHOT_ID = 103982;
  const reachableSize = runSpecRootCascadeTest(allNodes, AIMED_SHOT_ID);
  assert.ok(
    reachableSize >= 2,
    `expected at least 2 reachable nodes, got ${reachableSize}`,
  );
});

// ─── isFullySelected ─────────────────────────────────────────────────────────

test("isFullySelected: no selection entry is never full", () => {
  assert.strictEqual(isFullySelected(node(1, 0), undefined), false);
});

test("isFullySelected: non-choice node compares against node.maxRanks", () => {
  const n = node(1, 0, { maxRanks: 2 });
  assert.strictEqual(isFullySelected(n, sel(2)), true);
  assert.strictEqual(isFullySelected(n, sel(1)), false);
});

test("isFullySelected: choice node uses the CHOSEN option's max, not node.maxRanks", () => {
  // node.maxRanks (3) is deliberately larger than either option's max, mirroring
  // a node-level sum. A fully-picked single-rank option must satisfy a dependent
  // even though pointsInvested (1) is far below node.maxRanks.
  const choice = {
    id: 1,
    posX: 1,
    posY: 0,
    type: "choice",
    maxRanks: 3,
    choices: [
      { name: "X", maxRanks: 1 },
      { name: "Y", maxRanks: 2 },
    ],
  };
  // Option 0 (max 1) fully ranked at 1 point → full.
  assert.strictEqual(
    isFullySelected(choice, { pointsInvested: 1, entryChosen: 0 }),
    true,
  );
  // Option 1 (max 2) at 1 point → not yet full.
  assert.strictEqual(
    isFullySelected(choice, { pointsInvested: 1, entryChosen: 1 }),
    false,
  );
  // Option 1 (max 2) fully ranked at 2 points → full (still below node.maxRanks).
  assert.strictEqual(
    isFullySelected(choice, { pointsInvested: 2, entryChosen: 1 }),
    true,
  );
});

test("isFullySelected: choice option without an explicit maxRanks defaults to 1", () => {
  const choice = {
    id: 1,
    posX: 1,
    posY: 0,
    type: "choice",
    maxRanks: 1,
    choices: [{ name: "X" }, { name: "Y" }],
  };
  assert.strictEqual(
    isFullySelected(choice, { pointsInvested: 1, entryChosen: 0 }),
    true,
  );
});

test("isFullySelected: an unknown choice pick falls back to node.maxRanks", () => {
  const choice = {
    id: 1,
    posX: 1,
    posY: 0,
    type: "choice",
    maxRanks: 1,
    choices: [{ name: "X", maxRanks: 1 }],
  };
  assert.strictEqual(
    isFullySelected(choice, { pointsInvested: 1, entryChosen: null }),
    true,
  );
});

test("isFullySelected: an out-of-range choice pick is never full (corrupt)", () => {
  // entryChosen indexes past the real options (the 2-bit wire field encodes 0-3
  // even on a 2-option node; the parser clamps this, so only a corrupt interactive
  // or persisted selection reaches here). The chosen option does not exist, so the
  // pick cannot count as fully ranked and must not satisfy a dependent's prereq —
  // rather than defaulting its rank ceiling to 1 and passing on a single point.
  const choice = {
    id: 1,
    posX: 1,
    posY: 0,
    type: "choice",
    maxRanks: 1,
    choices: [{ name: "X" }, { name: "Y" }],
  };
  assert.strictEqual(
    isFullySelected(choice, { pointsInvested: 1, entryChosen: 5 }),
    false,
  );
});

test("isFullySelected: a choice node with no choices array uses node.maxRanks", () => {
  const choice = { id: 1, posX: 1, posY: 0, type: "choice", maxRanks: 1 };
  assert.strictEqual(
    isFullySelected(choice, { pointsInvested: 1, entryChosen: 0 }),
    true,
  );
});

test("isFullySelected: option ceiling keys off choices, not node.type (parser parity)", () => {
  // A node the data types as "apex" but that still carries a choices array with a
  // resolved pick must resolve to the CHOSEN option's max, exactly as
  // buildString's decode does — otherwise the gate would demand node.maxRanks (a
  // larger sum) and reject a pick the decoder treated as complete.
  const node = {
    id: 1,
    posX: 1,
    posY: 0,
    type: "apex",
    maxRanks: 3,
    choices: [
      { name: "X", maxRanks: 1 },
      { name: "Y", maxRanks: 2 },
    ],
  };
  assert.strictEqual(
    isFullySelected(node, { pointsInvested: 1, entryChosen: 0 }),
    true,
  );
  assert.strictEqual(
    isFullySelected(node, { pointsInvested: 1, entryChosen: 1 }),
    false,
  );
});

// ─── hasUpperPrereq ──────────────────────────────────────────────────────────

test("hasUpperPrereq: a choice-node parent is satisfied by fully ranking the chosen option", () => {
  // A choice-node prerequisite whose node.maxRanks (2) exceeds the chosen
  // option's max (1). Picking that option fully (1 point) must unlock the child;
  // the old node.maxRanks check required 2 points a single option can never hold.
  const parent = {
    id: 1,
    posX: 1,
    posY: 0,
    type: "choice",
    maxRanks: 2,
    treeType: "class",
    alreadyGranted: false,
    connections: [],
    choices: [
      { name: "X", maxRanks: 1 },
      { name: "Y", maxRanks: 1 },
    ],
  };
  const child = node(2, 1, { connections: [1] });
  assert.strictEqual(
    hasUpperPrereq(
      child,
      { 1: { pointsInvested: 1, entryChosen: 0 } },
      byId([parent, child]),
    ),
    true,
  );
});

test("hasUpperPrereq: a root node (no upper parent) always passes", () => {
  const root = node(1, 0);
  assert.strictEqual(hasUpperPrereq(root, {}, byId([root])), true);
});

test("hasUpperPrereq: an alreadyGranted upper parent satisfies it (nothing selected)", () => {
  // Granted parents are permanently satisfied — the prereq holds with an empty
  // selection. (Only reached via canSpendPoint; the validity cascade has its own
  // granted-parent check.)
  const parent = node(1, 0, { alreadyGranted: true });
  const child = node(2, 1, { connections: [1] });
  assert.strictEqual(hasUpperPrereq(child, {}, byId([parent, child])), true);
});

test("hasUpperPrereq: a fully-selected upper parent satisfies it", () => {
  const parent = node(1, 0);
  const child = node(2, 1, { connections: [1] });
  assert.strictEqual(
    hasUpperPrereq(child, { 1: sel() }, byId([parent, child])),
    true,
  );
});

test("hasUpperPrereq: an unselected (and not granted) upper parent fails it", () => {
  const parent = node(1, 0);
  const child = node(2, 1, { connections: [1] });
  assert.strictEqual(hasUpperPrereq(child, {}, byId([parent, child])), false);
});

test("hasUpperPrereq: a partially-ranked upper parent does not satisfy it", () => {
  const parent = node(1, 0, { maxRanks: 2 });
  const child = node(2, 1, { connections: [1] });
  assert.strictEqual(
    hasUpperPrereq(child, { 1: sel(1) }, byId([parent, child])),
    false,
  );
});

// ─── gatedPoints ─────────────────────────────────────────────────────────────

test("gatedPoints: non-hero node counts its whole treeType section", () => {
  // computeInvalidNodeIds now reads gate totals from a precomputed map; gatedPoints
  // stays the standalone reference other callers use, so guard it directly. A
  // non-hero node gates over its full treeType — equal to spentPoints(treeType).
  const a = node(1, 0, { treeType: "spec" });
  const b = node(2, 1, { maxRanks: 2, treeType: "spec", spentRequired: 2 });
  const other = node(3, 0, { treeType: "class" });
  const nodes = [a, b, other];
  const selected = { 1: sel(), 2: sel(2), 3: sel() };
  assert.strictEqual(
    gatedPoints(b, nodes, selected),
    spentPoints(nodes, selected, "spec"),
  );
  // Only spec points count (1 + 2), the class pick is in a different section.
  assert.strictEqual(gatedPoints(b, nodes, selected), 3);
});

test("gatedPoints: hero node counts only its own subtree", () => {
  // A hero node gates per heroSubtree — equal to spentPoints(treeType, subtree).
  const left = { ...node(50, 0, { treeType: "hero" }), heroSubtree: "L" };
  const right = { ...node(51, 0, { treeType: "hero" }), heroSubtree: "R" };
  const nodes = [left, right];
  const selected = { 50: sel(), 51: sel() };
  assert.strictEqual(
    gatedPoints(left, nodes, selected),
    spentPoints(nodes, selected, "hero", "L"),
  );
  assert.strictEqual(gatedPoints(left, nodes, selected), 1);
  assert.strictEqual(gatedPoints(right, nodes, selected), 1);
});

// ─── Single-pass gate-total edge cases ───────────────────────────────────────

test("gate total matches gatedPoints for a hero node lacking a subtree", () => {
  // The precomputed section key folds a subtree-less hero node under one bucket,
  // exactly as gatedPoints (heroSubtree undefined) would count it. With no committed
  // subtree the exclusivity check is inert, so the gate path runs: one point, gate 0,
  // nothing flagged — the same verdict gatedPoints yields.
  const hero = { ...node(70, 0, { treeType: "hero", spentRequired: 0 }) };
  delete hero.heroSubtree;
  const nodes = [hero];
  const selected = { 70: sel() };
  assert.strictEqual(gatedPoints(hero, nodes, selected), 1);
  assertInvalid(computeInvalidNodeIds(nodes, selected, byId(nodes)));
});

test("zero-point selected node alone in its section fails its gate", () => {
  // A selected entry carrying 0 points contributes nothing to its section total, so
  // the section is absent from the precomputed map and reads as 0 — matching
  // gatedPoints/spentPoints, which also sum to 0. With spentRequired > 0 the node
  // fails its gate and is flagged.
  const lone = node(80, 0, { treeType: "spec", spentRequired: 1 });
  const nodes = [lone];
  const selected = { 80: sel(0) };
  assert.strictEqual(gatedPoints(lone, nodes, selected), 0);
  assertInvalid(computeInvalidNodeIds(nodes, selected, byId(nodes)), 80);
});

// ─── cellKey uniqueness across sections ───────────────────────────────────────
// sectionSpentTotals (and spentPoints) de-duplicate co-located picks with a
// SINGLE countedCells set that spans every section. That is only correct because
// cellKey encodes treeType + heroSubtree, so no two sections ever produce the same
// key — a cell in the class panel and a cell at the same grid position in the spec
// or a hero panel stay distinct. These tests pin that invariant so a future
// refactor of cellKey can't silently collapse cells across panels and under-count
// a section's spent points (e.g. 35/34 class).

test("cellKey distinguishes identical grid positions in different sections", () => {
  const at = (treeType, heroSubtree = null) => ({
    treeType,
    heroSubtree,
    posX: 0,
    posY: 0,
  });
  const keys = [
    cellKey(at("class")),
    cellKey(at("spec")),
    cellKey(at("hero", "left")),
    cellKey(at("hero", "right")),
  ];
  assert.strictEqual(
    new Set(keys).size,
    keys.length,
    "same posX/posY across sections must yield distinct cellKeys",
  );
});

test("cellKey never collides across sections in any class's data", () => {
  const classIndex = require("../data/classes.json");
  for (const cls of classIndex.filter((c) => c.implemented)) {
    const data = require(`../data/${cls.name}.json`);
    for (const [slug, spec] of Object.entries(data.specs)) {
      const sectionByKey = new Map();
      for (const n of spec.nodes) {
        const section = `${n.treeType}|${n.heroSubtree ?? ""}`;
        const key = cellKey(n);
        const prev = sectionByKey.get(key);
        if (prev === undefined) sectionByKey.set(key, section);
        else
          assert.strictEqual(
            prev,
            section,
            `${slug}: cellKey "${key}" shared across sections ${prev} and ${section}`,
          );
      }
    }
  }
});

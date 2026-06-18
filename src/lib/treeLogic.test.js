/**
 * Verification tests for computeInvalidNodeIds.
 *
 * Run:  npm test   (or: npx vitest run src/lib/treeLogic.test.js)
 *
 * Assertions use Node's built-in assert module inside Vitest's test runner.
 */

import { test } from 'vitest'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { computeInvalidNodeIds } from './treeLogic.js'

const require = createRequire(import.meta.url)

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
function node(id, posY, {
  maxRanks      = 1,
  spentRequired = 0,
  connections   = [],
  treeType      = 'class',
  alreadyGranted = false,
} = {}) {
  return { id, posX: id, posY, maxRanks, spentRequired, connections, treeType, alreadyGranted }
}

/** Shorthand: one selection entry at full rank */
function sel(pts = 1) { return { pointsInvested: pts, entryChosen: null } }

/** Build a nodeById map from an array of nodes */
function byId(nodes) {
  const m = {}
  for (const n of nodes) m[n.id] = n
  return m
}

/**
 * Assert the invalid set matches exactly the given IDs (order-independent).
 */
function assertInvalid(actual, ...expectedIds) {
  const got  = [...actual].sort((a, b) => a - b)
  const want = [...expectedIds].sort((a, b) => a - b)
  assert.deepStrictEqual(got, want,
    `invalid: expected [${want}] but got [${got}]`)
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
]

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
]

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
]

// ─── Tests ────────────────────────────────────────────────────────────────────


test('nothing invalid when all selected', () => {
  const selected = { 1: sel(), 2: sel(), 3: sel() }
  assertInvalid(computeInvalidNodeIds(CHAIN, selected, byId(CHAIN)))
})

test('only direct child invalid when root removed', () => {
  // A removed; B has no valid parent, C has B as parent (still selected but invalid)
  const selected = { 2: sel(), 3: sel() }
  // Current (broken) behaviour would only flag 2; fixed code must also flag 3
  assertInvalid(computeInvalidNodeIds(CHAIN, selected, byId(CHAIN)), 2, 3)
})

test('grandchild is invalid when root removed (cascade)', () => {
  // Explicit re-statement: 3 depends on 2 which is invalid → 3 must be flagged
  const selected = { 2: sel(), 3: sel() }
  const invalid = computeInvalidNodeIds(CHAIN, selected, byId(CHAIN))
  assert.ok(invalid.has(2), 'node 2 should be invalid')
  assert.ok(invalid.has(3), 'node 3 should be invalid (grandchild cascade)')
})

test('re-adding the root clears all invalidity', () => {
  const selected = { 1: sel(), 2: sel(), 3: sel() }
  assertInvalid(computeInvalidNodeIds(CHAIN, selected, byId(CHAIN)))
})

test('removing middle node: child invalid, root still valid', () => {
  // A present, B removed, C has no valid parent
  const selected = { 1: sel(), 3: sel() }
  assertInvalid(computeInvalidNodeIds(CHAIN, selected, byId(CHAIN)), 3)
})


test('all selected → nothing invalid', () => {
  const selected = { 1: sel(), 2: sel(), 3: sel(), 4: sel() }
  assertInvalid(computeInvalidNodeIds(DIAMOND, selected, byId(DIAMOND)))
})

test('removing one branch leaves D valid via the other branch', () => {
  // B removed — D still has C as a valid parent
  const selected = { 1: sel(), 3: sel(), 4: sel() }
  assertInvalid(computeInvalidNodeIds(DIAMOND, selected, byId(DIAMOND)))
})

test('removing root A cascades to B, C, and D', () => {
  // A gone → B and C have no parent → D has only invalid parents
  const selected = { 2: sel(), 3: sel(), 4: sel() }
  assertInvalid(computeInvalidNodeIds(DIAMOND, selected, byId(DIAMOND)), 2, 3, 4)
})

test('removing A and B leaves C valid, D valid (C path survives)', () => {
  // A gone → C invalid (no parent). D: C invalid, B absent → D invalid.
  const selected = { 3: sel(), 4: sel() }
  assertInvalid(computeInvalidNodeIds(DIAMOND, selected, byId(DIAMOND)), 3, 4)
})


test('all selected at full rank → nothing invalid', () => {
  // P=2pts, Q=1pt, R=1pt, S=1pt → total=5, threshold=3 → fine
  const selected = { 10: sel(2), 11: sel(), 12: sel(), 13: sel() }
  assertInvalid(computeInvalidNodeIds(GATE, selected, byId(GATE)))
})

test('removing Q drops total to 4 — still above gate', () => {
  // P=2, R=1, S=1 → total=4 ≥ 3
  const selected = { 10: sel(2), 12: sel(), 13: sel() }
  assertInvalid(computeInvalidNodeIds(GATE, selected, byId(GATE)))
})

test('removing P drops total below gate: R and S flagged', () => {
  // Q=1, R=1, S=1 → total=3; gate=3 so exactly met → still valid
  // Let's remove Q too to drop below
  const selected = { 12: sel(), 13: sel() }
  // Total=2 < 3 → R invalid (gate); R invalid → S invalid (cascade from prereq)
  assertInvalid(computeInvalidNodeIds(GATE, selected, byId(GATE)), 12, 13)
})

test('gate violation on R cascades to S via prereq invalidity', () => {
  // Same removal: R gate-invalid → S's parent (R) is invalid → S also invalid
  const selected = { 12: sel(), 13: sel() }
  const invalid = computeInvalidNodeIds(GATE, selected, byId(GATE))
  assert.ok(invalid.has(12), 'R(12) should be invalid due to gate')
  assert.ok(invalid.has(13), 'S(13) should be invalid due to cascade from invalid R')
})

test('decrementing P one rank keeps gate met (total still ≥ 3)', () => {
  // P=1, Q=1, R=1, S=1 → total=4 ≥ 3
  const selected = { 10: sel(1), 11: sel(), 12: sel(), 13: sel() }
  assertInvalid(computeInvalidNodeIds(GATE, selected, byId(GATE)))
})


test('alreadyGranted parent is always satisfied — child never invalid', () => {
  const root  = node(20, 0, { alreadyGranted: true, connections: [21] })
  const child = node(21, 1, { connections: [20] })
  const nodes = [root, child]
  // Only child is in selected (root is alreadyGranted — seeded but its presence
  // in selected does not affect this check since it's filtered out)
  const selected = { 20: sel(), 21: sel() }
  assertInvalid(computeInvalidNodeIds(nodes, selected, byId(nodes)))
})

test('alreadyGranted node itself is never flagged even when selected', () => {
  const root = node(20, 0, { alreadyGranted: true })
  const nodes = [root]
  const selected = { 20: sel() }
  assertInvalid(computeInvalidNodeIds(nodes, selected, byId(nodes)))
})


test('parent at partial rank does not satisfy child prereq', () => {
  // A has maxRanks=2; B requires A to be FULLY selected (2/2)
  const twoRankRoot = node(30, 0, { maxRanks: 2, connections: [31] })
  const child       = node(31, 1, { connections: [30] })
  const nodes = [twoRankRoot, child]

  // A at 1/2 → child's prereq not met → child invalid
  const selected = { 30: sel(1), 31: sel() }
  assertInvalid(computeInvalidNodeIds(nodes, selected, byId(nodes)), 31)
})

test('parent at full rank satisfies child prereq', () => {
  const twoRankRoot = node(30, 0, { maxRanks: 2, connections: [31] })
  const child       = node(31, 1, { connections: [30] })
  const nodes = [twoRankRoot, child]

  const selected = { 30: sel(2), 31: sel() }
  assertInvalid(computeInvalidNodeIds(nodes, selected, byId(nodes)))
})

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
  const nodeById = {}
  for (const n of allNodes) nodeById[n.id] = n
  const remaining = { ...fullySelected }
  for (const id of removeIds) delete remaining[id]
  return computeInvalidNodeIds(allNodes, remaining, nodeById)
}

// ─── Feral Druid integration test ─────────────────────────────────────────────


test('removing Tiger\'s Fury invalidates all connection-dependent spec nodes, not class or hero', () => {
  const druid = require('../data/druid.json')
  // Feral Druid spec = specId 103, keyed as "feral" in druid.json
  const allNodes = druid.specs.feral.nodes

  const TIGERS_FURY_ID = 82124

  // Build a fully-selected map: every non-granted node at full rank
  const fullySelected = {}
  for (const n of allNodes) {
    if (!n.alreadyGranted) {
      fullySelected[n.id] = { pointsInvested: n.maxRanks, entryChosen: null }
    }
  }

  const invalid = invalidAfterRemoving(allNodes, fullySelected, TIGERS_FURY_ID)

  // Tiger's Fury itself was removed, not selected, so it must NOT appear in invalid
  assert.ok(!invalid.has(TIGERS_FURY_ID), 'Tiger\'s Fury was removed — should not be in invalid set')

  // BFS: find all spec nodes reachable from Tiger's Fury via parent→child edges.
  // A child lists its parent in its own connections array.
  const nodeById = {}
  for (const n of allNodes) nodeById[n.id] = n
  const childrenOf = {}
  for (const n of allNodes) {
    if (n.treeType !== 'spec' || n.alreadyGranted) continue
    for (const cid of n.connections) {
      const parent = nodeById[cid]
      if (parent && parent.posY < n.posY) {
        if (!childrenOf[parent.id]) childrenOf[parent.id] = []
        childrenOf[parent.id].push(n.id)
      }
    }
  }
  const reachable = new Set([TIGERS_FURY_ID])
  const queue = [TIGERS_FURY_ID]
  while (queue.length) {
    const id = queue.shift()
    for (const c of (childrenOf[id] ?? [])) {
      if (!reachable.has(c)) { reachable.add(c); queue.push(c) }
    }
  }
  // All reachable nodes except Tiger's Fury itself should be invalid after its removal
  for (const id of reachable) {
    if (id === TIGERS_FURY_ID) continue
    assert.ok(invalid.has(id), `spec node ${id} (posY=${nodeById[id].posY}) reachable from Tiger's Fury should be invalid`)
  }
  // Spec nodes that are not reachable (e.g. standalone gate-only apex nodes) should NOT be invalid
  const unreachableSpec = allNodes.filter(
    (n) => n.treeType === 'spec' && !n.alreadyGranted && !reachable.has(n.id),
  )
  for (const n of unreachableSpec) {
    assert.ok(!invalid.has(n.id), `unreachable spec node ${n.id} should NOT be invalid`)
  }

  // Class nodes must not be invalidated
  const classNodes = allNodes.filter((n) => n.treeType === 'class' && !n.alreadyGranted)
  for (const n of classNodes) {
    assert.ok(!invalid.has(n.id), `class node ${n.id} should NOT be invalid`)
  }

  // Hero nodes must not be invalidated
  const heroNodes = allNodes.filter((n) => n.treeType === 'hero' && !n.alreadyGranted)
  for (const n of heroNodes) {
    assert.ok(!invalid.has(n.id), `hero node ${n.id} should NOT be invalid`)
  }

  // Confirm the cascade depth: reachable set should contain 38 nodes (Tiger's Fury + 37 descendants)
  assert.strictEqual(reachable.size, 38, `expected 38 reachable nodes, got ${reachable.size}`)
})

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
  const nodeById = {}
  for (const n of allNodes) nodeById[n.id] = n

  const fullySelected = {}
  for (const n of allNodes) {
    if (!n.alreadyGranted) {
      fullySelected[n.id] = { pointsInvested: n.maxRanks, entryChosen: null }
    }
  }

  const invalid = invalidAfterRemoving(allNodes, fullySelected, rootId)

  assert.ok(!invalid.has(rootId), `root ${rootId} was removed — must not appear in invalid set`)

  // BFS from root through spec parent→child edges
  const childrenOf = {}
  for (const n of allNodes) {
    if (n.treeType !== 'spec' || n.alreadyGranted) continue
    for (const cid of n.connections) {
      const parent = nodeById[cid]
      if (parent && parent.posY < n.posY) {
        if (!childrenOf[parent.id]) childrenOf[parent.id] = []
        childrenOf[parent.id].push(n.id)
      }
    }
  }
  const reachable = new Set([rootId])
  const queue = [rootId]
  while (queue.length) {
    const id = queue.shift()
    for (const c of (childrenOf[id] ?? [])) {
      if (!reachable.has(c)) { reachable.add(c); queue.push(c) }
    }
  }

  for (const id of reachable) {
    if (id === rootId) continue
    assert.ok(invalid.has(id),
      `spec node ${id} (posY=${nodeById[id].posY}) reachable from root ${rootId} should be invalid`)
  }
  const unreachableSpec = allNodes.filter(
    (n) => n.treeType === 'spec' && !n.alreadyGranted && !reachable.has(n.id),
  )
  for (const n of unreachableSpec) {
    assert.ok(!invalid.has(n.id), `unreachable spec node ${n.id} should NOT be invalid`)
  }
  for (const n of allNodes.filter((n) => n.treeType === 'class' && !n.alreadyGranted)) {
    assert.ok(!invalid.has(n.id), `class node ${n.id} should NOT be invalid`)
  }
  for (const n of allNodes.filter((n) => n.treeType === 'hero' && !n.alreadyGranted)) {
    assert.ok(!invalid.has(n.id), `hero node ${n.id} should NOT be invalid`)
  }

  return reachable.size
}

// ─── Warrior Protection integration test (tank) ───────────────────────────────


test('removing Ignore Pain invalidates all connection-dependent spec nodes, not class or hero', () => {
  const warrior = require('../data/warrior.json')
  const allNodes = warrior.specs.protection.nodes
  const IGNORE_PAIN_ID = 90295
  const reachableSize = runSpecRootCascadeTest(allNodes, IGNORE_PAIN_ID)
  assert.ok(reachableSize >= 2, `expected at least 2 reachable nodes, got ${reachableSize}`)
})

// ─── Paladin Holy integration test (healer) ───────────────────────────────────


test('removing Holy Shock invalidates all connection-dependent spec nodes, not class or hero', () => {
  const paladin = require('../data/paladin.json')
  const allNodes = paladin.specs.holy.nodes
  const HOLY_SHOCK_ID = 81555
  const reachableSize = runSpecRootCascadeTest(allNodes, HOLY_SHOCK_ID)
  assert.ok(reachableSize >= 2, `expected at least 2 reachable nodes, got ${reachableSize}`)
})

// ─── Hunter Marksmanship integration test (ranged DPS) ───────────────────────


test('removing Aimed Shot invalidates all connection-dependent spec nodes, not class or hero', () => {
  const hunter = require('../data/hunter.json')
  const allNodes = hunter.specs.marksmanship.nodes
  const AIMED_SHOT_ID = 103982
  const reachableSize = runSpecRootCascadeTest(allNodes, AIMED_SHOT_ID)
  assert.ok(reachableSize >= 2, `expected at least 2 reachable nodes, got ${reachableSize}`)
})


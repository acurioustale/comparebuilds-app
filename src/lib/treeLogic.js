// ─── Prerequisite and gate logic — shared between interactive and import views ─

/**
 * Returns true if at least one directly connected upper parent (posY < node.posY)
 * is fully selected. alreadyGranted parents are treated as permanently satisfied.
 * Nodes with no upper connections (root nodes) always pass.
 */
export function hasUpperPrereq(node, selected, nodeById) {
  const upper = node.connections
    .map((id) => nodeById[id])
    .filter((c) => c && c.posY < node.posY)
  if (upper.length === 0) return true
  return upper.some((c) => {
    if (c.alreadyGranted) return true
    const s = selected[c.id]
    return s && s.pointsInvested >= c.maxRanks
  })
}

/**
 * Points spent in the same tree section as `node`, counting per-heroSubtree
 * for hero nodes. Excludes alreadyGranted nodes (they don't consume the budget).
 * Used for spentRequired gate checks.
 */
export function gatedPoints(node, allNodes, selected) {
  let total = 0
  for (const n of allNodes) {
    if (n.alreadyGranted || n.treeType !== node.treeType) continue
    if (node.treeType === 'hero' && n.heroSubtree !== node.heroSubtree) continue
    total += selected[n.id]?.pointsInvested ?? 0
  }
  return total
}

// ─── Exports used by both interactive and import contexts ─────────────────────

/**
 * Builds an interactiveNodes map seeded with all alreadyGranted nodes at their
 * full rank. These nodes must be present in the selection state so that
 * prerequisite checks evaluate against the full effective selection set.
 * @param {object} treeData
 * @returns {Record<number, {pointsInvested: number, entryChosen: null}>}
 */
export function buildGrantedSeed(treeData) {
  const seed = {}
  for (const n of treeData.nodes) {
    if (n.alreadyGranted) seed[n.id] = { pointsInvested: n.maxRanks, entryChosen: null }
  }
  return seed
}

/**
 * Returns a Set of node IDs that are currently selected but violate their own
 * prerequisites or gate thresholds given the current selection state.
 *
 * Uses a topological sort (posY ascending, then posX) so that every parent is
 * evaluated before its children. A single pass is sufficient — no fixpoint
 * iteration needed — and deep cascades are always complete.
 *
 * Gate check uses the raw selected totals (invalid nodes' points still count
 * toward the sum — gate violations stem from actual point removals, not from
 * cascaded invalidity).
 *
 * alreadyGranted nodes are never flagged; they are permanently valid.
 *
 * @param {object[]} allNodes  treeData.nodes
 * @param {object}   selected  interactiveNodes map, including any granted-seed entries
 * @param {object}   nodeById  Map of id → node
 * @returns {Set<number>}
 */
export function computeInvalidNodeIds(allNodes, selected, nodeById) {
  const invalid = new Set()

  // Topological order: posY ascending guarantees parents processed before children.
  const sorted = allNodes
    .filter((n) => selected[n.id] && !n.alreadyGranted)
    .sort((a, b) => a.posY !== b.posY ? a.posY - b.posY : a.posX - b.posX)

  for (const node of sorted) {
    let shouldFlag = false

    // Gate: raw selected point total — does not exclude already-invalid nodes
    if (gatedPoints(node, allNodes, selected) < node.spentRequired) {
      shouldFlag = true
    }

    // Prereq cascade: an invalid parent does NOT satisfy the requirement
    if (!shouldFlag) {
      const upper = node.connections
        .map((id) => nodeById[id])
        .filter((c) => c && c.posY < node.posY)

      if (upper.length > 0) {
        const anyValidParent = upper.some((c) => {
          if (c.alreadyGranted) return true       // always satisfied
          if (invalid.has(c.id)) return false     // invalid parent doesn't count
          const s = selected[c.id]
          return s && s.pointsInvested >= c.maxRanks
        })
        if (!anyValidParent) shouldFlag = true
      }
    }

    if (shouldFlag) invalid.add(node.id)
  }

  return invalid
}

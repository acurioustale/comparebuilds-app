// ─── Interactive spend rules ──────────────────────────────────────────────────
//
// Pure rules governing whether a point may be spent on a node in the interactive
// calculator. Extracted from InteractiveTalentTree so the spend logic — section
// budgets, hero-subtree exclusivity, gates, and prerequisites — can be unit-tested
// without a DOM.

import { hasUpperPrereq, gatedPoints, spentPoints } from "./treeLogic.js";

/**
 * Total points spent in a tree section (class/spec/hero), excluding granted nodes.
 */
export function sectionPoints(treeType, allNodes, selected) {
  return spentPoints(allNodes, selected, treeType);
}

/**
 * Name of the hero subtree the player has committed to (first selected, non-granted
 * hero node), or null if none yet.
 */
export function activeHeroSubtree(allNodes, selected) {
  for (const n of allNodes) {
    if (n.treeType === "hero" && !n.alreadyGranted && selected[n.id])
      return n.heroSubtree;
  }
  return null;
}

/**
 * Whether a point may currently be spent on `node`, considering: granted status,
 * hero-subtree exclusivity, the section point budget, the node's gate threshold,
 * and its upper prerequisite.
 *
 * @param {object} node
 * @param {object[]} allNodes
 * @param {object} selected   selection map (incl. granted seed)
 * @param {object} nodeById   id → node
 * @param {{class:number, spec:number, hero:number}} budget
 * @returns {boolean}
 */
export function canSpendPoint(node, allNodes, selected, nodeById, budget) {
  if (node.alreadyGranted) return false;
  if (node.treeType === "hero") {
    const activeSub = activeHeroSubtree(allNodes, selected);
    if (activeSub !== null && activeSub !== node.heroSubtree) return false;
  }
  if (sectionPoints(node.treeType, allNodes, selected) >= budget[node.treeType])
    return false;
  if (gatedPoints(node, allNodes, selected) < node.spentRequired) return false;
  return hasUpperPrereq(node, selected, nodeById);
}

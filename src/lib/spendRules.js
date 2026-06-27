// ─── Interactive spend rules ──────────────────────────────────────────────────
//
// Pure rules governing whether a point may be spent on a node in the interactive
// calculator. Extracted from InteractiveTalentTree so the spend logic — section
// budgets, hero-subtree exclusivity, gates, and prerequisites — can be unit-tested
// without a DOM.

import {
  hasUpperPrereq,
  gatedPoints,
  spentPoints,
  cellKey,
  activeHeroSubtree,
} from "./treeLogic.js";

// activeHeroSubtree lives in treeLogic (shared with the validity cascade); keep
// re-exporting it here so the interactive component's import path is unchanged.
export { activeHeroSubtree };

/**
 * Total points spent in a tree section (class/spec/hero), excluding granted nodes.
 */
export function sectionPoints(treeType, allNodes, selected) {
  return spentPoints(allNodes, selected, treeType);
}

/**
 * The selection to encode when exporting an interactive build: a copy of
 * `selected` with the *inactive* hero subtree's auto-granted roots removed.
 *
 * buildGrantedSeed seeds the granted roots of BOTH hero subtrees so prerequisite
 * checks evaluate correctly before a subtree is chosen. Once a subtree is active,
 * the other subtree's granted root is not point-relevant and must not survive into
 * the export: it is not in the encoder's `grantedIds`, so generateBuildString would
 * otherwise treat it as a purchased node (isSelected=1/isPurchased=1) and emit a
 * non-canonical string. Active-subtree and class/spec grants stay — the encoder
 * writes those as granted via `grantedIds`. With no subtree active (activeSubtree
 * null) every granted hero root is pruned, matching the game's export.
 */
export function prunedExportSelection(allNodes, selected, activeSubtree) {
  const pruned = { ...selected };
  for (const n of allNodes) {
    if (
      n.alreadyGranted &&
      n.treeType === "hero" &&
      n.heroSubtree !== activeSubtree
    ) {
      delete pruned[n.id];
    }
  }
  return pruned;
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
  // Co-located exclusivity: a cell holds at most one purchased node, so refuse
  // this one if a different non-granted node sharing its cell is already taken.
  const cell = cellKey(node);
  for (const other of allNodes) {
    if (
      other.id !== node.id &&
      !other.alreadyGranted &&
      selected[other.id] &&
      cellKey(other) === cell
    ) {
      return false;
    }
  }
  if (sectionPoints(node.treeType, allNodes, selected) >= budget[node.treeType])
    return false;
  if (gatedPoints(node, allNodes, selected) < node.spentRequired) return false;
  return hasUpperPrereq(node, selected, nodeById);
}

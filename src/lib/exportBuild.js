import { generateBuildString, heroGateSelection } from "./buildString.js";
import {
  activeHeroSubtree,
  heroSubtreePoints,
  prunedExportSelection,
} from "./spendRules.js";

/**
 * Generates a valid build string from an interactive selection by pruning
 * inactive hero subtrees, injecting the hero gate selection, and collecting
 * granted node IDs before encoding.
 *
 * @param {object} treeData Spec tree data definition
 * @param {Record<number, { pointsInvested: number, entryChosen: number|null }>} selected Interactive selection state
 * @param {number} specId Active spec ID
 * @param {Array<{ id: number, maxRanks: number, choices: Array<{maxRanks:number}>|null }>} classNodes Full class node list
 * @returns {string} Base64 build string
 */
export function buildExportString(treeData, selected, specId, classNodes) {
  if (!treeData || !specId || !classNodes) return "";
  const activeSub = activeHeroSubtree(treeData.nodes, selected);

  const exportSelection = prunedExportSelection(
    treeData.nodes,
    selected,
    activeSub,
  );
  // Points in the ACTIVE hero subtree — the sole basis for whether a hero gate
  // belongs in the export. Read from `selected`'s spend memo, already warmed by
  // the activeHeroSubtree() call above, rather than re-tallying the freshly built
  // exportSelection (whose identity always misses the memo and forces another
  // full node walk). Scoping to the active subtree keeps the count robust to a
  // corrupt dual-subtree selection, matching what the pruned selection would sum.
  const heroSpent = heroSubtreePoints(treeData.nodes, selected, activeSub);
  // Resolve the active subtree to the left/right hero-gate slot by name. A live
  // subtree must match one of the two known names; anything else means the
  // node's heroSubtree has drifted from heroSubtrees.left/right (a data or
  // ingest regression). Fail loudly instead of silently encoding the gate as
  // left and exporting a string that decodes to the wrong hero subtree. The
  // interactive caller catches this and disables export rather than crashing.
  const { left, right } = treeData.heroSubtrees ?? {};
  let activeSubtreeIsRight = false;
  if (activeSub != null) {
    if (activeSub === right?.name) {
      activeSubtreeIsRight = true;
    } else if (activeSub !== left?.name) {
      throw new Error(
        `Active hero subtree "${activeSub}" matches neither ` +
          `heroSubtrees.left ("${left?.name}") nor .right ("${right?.name}").`,
      );
    }
  }
  const gateSel = heroGateSelection(heroSpent, activeSubtreeIsRight);
  if (gateSel && treeData.heroGateNodeId != null) {
    exportSelection[treeData.heroGateNodeId] = gateSel;
  }
  const grantedIds = new Set(
    treeData.nodes
      .filter(
        (n) =>
          n.alreadyGranted &&
          (n.treeType !== "hero" || n.heroSubtree === activeSub),
      )
      .map((n) => n.id),
  );
  return generateBuildString(exportSelection, specId, classNodes, grantedIds);
}

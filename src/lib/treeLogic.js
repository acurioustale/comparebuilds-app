// ─── Prerequisite and gate logic — shared between interactive and import views ─

/**
 * Directly connected parents sitting above `node` (posY less than node's). These
 * are its prerequisite candidates — satisfying any one of them unlocks the node.
 * Shared by hasUpperPrereq and computeInvalidNodeIds so the two never drift.
 */
export function upperParents(node, nodeById) {
  return node.connections
    .map((id) => nodeById[id])
    .filter((c) => c && c.posY < node.posY);
}

/**
 * Returns true if at least one directly connected upper parent (posY < node.posY)
 * is fully selected. alreadyGranted parents are treated as permanently satisfied.
 * Nodes with no upper connections (root nodes) always pass.
 */
export function hasUpperPrereq(node, selected, nodeById) {
  const upper = upperParents(node, nodeById);
  if (upper.length === 0) return true;
  return upper.some((c) => {
    if (c.alreadyGranted) return true;
    const s = selected[c.id];
    return s && s.pointsInvested >= c.maxRanks;
  });
}

/**
 * Points invested across `allNodes` within one tree section, excluding granted
 * nodes (they don't consume the budget). When `heroSubtree` is given, only nodes
 * in that subtree count; otherwise the whole `treeType` counts.
 *
 * Counts at most one purchased node per co-located cell. A cell is a single
 * talent slot; the ingest already collapses its duplicate node records to one id
 * (see cellKey), so this only matters when a tool-built string sets a
 * since-collapsed duplicate's bit. Counting both would over-report the section by
 * a point per duplicate (e.g. 35/34 class), so collapse co-located picks to one.
 *
 * Single shared accumulator behind both the section-budget check (sectionPoints)
 * and the gate check (gatedPoints) so the two can't drift.
 */
export function spentPoints(allNodes, selected, treeType, heroSubtree = null) {
  let total = 0;
  const countedCells = new Set();
  for (const n of allNodes) {
    if (n.alreadyGranted || n.treeType !== treeType) continue;
    if (heroSubtree != null && n.heroSubtree !== heroSubtree) continue;
    const pts = selected[n.id]?.pointsInvested ?? 0;
    if (pts === 0) continue;
    const cell = cellKey(n);
    // Co-located duplicate — count the cell once. Which duplicate's points are
    // kept is the iteration order (first wins), but that is moot: the ingest
    // parks every co-located duplicate out of `nodes` (collapseColocatedDuplicates),
    // so `allNodes` never holds two ids for one cell. A tool-built string can set
    // a parked id's bit, but parked ids aren't in `allNodes` either, so their
    // stray points are simply not counted here.
    if (countedCells.has(cell)) continue;
    countedCells.add(cell);
    total += pts;
  }
  return total;
}

/**
 * Points spent in the same tree section as `node`, counting per-heroSubtree
 * for hero nodes. Excludes alreadyGranted nodes (they don't consume the budget).
 * Used for spentRequired gate checks. Delegates to spentPoints so the gate and
 * section-budget totals share one accumulator (including the co-located-cell
 * collapse) and can't drift.
 */
export function gatedPoints(node, allNodes, selected) {
  const heroSubtree = node.treeType === "hero" ? node.heroSubtree : null;
  return spentPoints(allNodes, selected, node.treeType, heroSubtree);
}

/**
 * A grid-cell key. Nodes that render on the same spot share it: the same panel
 * (treeType, plus heroSubtree for hero nodes) and the same posX,posY.
 *
 * Some talents are reachable through more than one node id at one cell — a
 * Blizzard tree quirk. A cell is one talent slot worth one point however many of
 * its ids a serialised build sets (the game's own export keeps one; tool-built
 * strings can set several), so the app counts (spentPoints), gates (gatedPoints),
 * and encodes (prunedExportSelection) a cell as a single talent.
 *
 * The ingest collapses every such cell to a single canonical id (the lowest —
 * what the game's export keeps), parking the duplicates in unusedNodeIds, so the
 * data that reaches the app already holds one node per cell (druid Starfire and
 * Moonkin Form, paladin Lightforged Blessing). This logic is therefore the net
 * for a tool-built string that still sets a since-collapsed duplicate's bit.
 * (Co-located *granted* roots — Halo-style pairs that are auto-granted together —
 * are exempt; they are never purchased.)
 */
export function cellKey(node) {
  return `${node.treeType}|${node.heroSubtree ?? ""}|${node.posX},${node.posY}`;
}

/**
 * Name of the hero subtree the player has committed to — the first selected,
 * non-granted hero node in node order — or null if none yet. The single source
 * of "which subtree is active", shared by the spend rules and the validity
 * cascade so the interactive and import views agree.
 */
export function activeHeroSubtree(allNodes, selected) {
  for (const n of allNodes) {
    if (n.treeType === "hero" && !n.alreadyGranted && selected[n.id])
      return n.heroSubtree;
  }
  return null;
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
  const seed = {};
  for (const n of treeData.nodes) {
    if (n.alreadyGranted)
      seed[n.id] = { pointsInvested: n.maxRanks, entryChosen: null };
  }
  return seed;
}

/**
 * Returns a Set of node IDs that are currently selected but violate their own
 * prerequisites or gate thresholds given the current selection state.
 *
 * Uses a topological sort (posY ascending, then posX) so that every parent is
 * evaluated before its children. A single pass is sufficient — no fixpoint
 * iteration needed — and deep cascades are always complete.
 *
 * Gate check counts the selected section total (one node per co-located cell;
 * see gatedPoints). Prereq-invalid nodes' points still count toward the sum —
 * gate violations stem from actual point removals, not from cascaded invalidity.
 *
 * A co-located cell's duplicate node ids are NOT flagged: they are records for a
 * single talent (see cellKey), so a build that sets several of them is the same
 * one-point pick, not a conflict — spentPoints/gatedPoints already collapse the
 * cell to one and the exporter emits one id, matching the game's canonical form.
 *
 * alreadyGranted nodes are never flagged; they are permanently valid.
 *
 * @param {object[]} allNodes  treeData.nodes
 * @param {object}   selected  interactiveNodes map, including any granted-seed entries
 * @param {object}   nodeById  Map of id → node
 * @returns {Set<number>}
 */
export function computeInvalidNodeIds(allNodes, selected, nodeById) {
  const invalid = new Set();

  // Topological order: posY ascending guarantees parents processed before
  // children. The posX then id tiebreakers just make the walk deterministic.
  const sorted = allNodes
    .filter((n) => selected[n.id] && !n.alreadyGranted)
    .sort((a, b) =>
      a.posY !== b.posY
        ? a.posY - b.posY
        : a.posX !== b.posX
          ? a.posX - b.posX
          : a.id - b.id,
    );

  // Hero-subtree exclusivity: a build may invest in only one hero subtree. A
  // crafted/corrupt build string (or an import path that bypasses canSpendPoint)
  // could carry picks in both — flag everything outside the active subtree so the
  // diff/heatmap/import views can't render an impossible dual-subtree build as
  // legal, matching what canSpendPoint forbids interactively.
  const activeHeroSub = activeHeroSubtree(allNodes, selected);

  for (const node of sorted) {
    let shouldFlag = false;

    // Hero-subtree exclusivity: nodes outside the committed subtree are invalid.
    if (
      node.treeType === "hero" &&
      activeHeroSub !== null &&
      node.heroSubtree !== activeHeroSub
    ) {
      shouldFlag = true;
    }

    // Gate: raw selected point total — does not exclude already-invalid nodes
    if (
      !shouldFlag &&
      gatedPoints(node, allNodes, selected) < node.spentRequired
    ) {
      shouldFlag = true;
    }

    // Prereq cascade: an invalid parent does NOT satisfy the requirement
    if (!shouldFlag) {
      const upper = upperParents(node, nodeById);

      if (upper.length > 0) {
        const anyValidParent = upper.some((c) => {
          if (c.alreadyGranted) return true; // always satisfied
          if (invalid.has(c.id)) return false; // invalid parent doesn't count
          const s = selected[c.id];
          return s && s.pointsInvested >= c.maxRanks;
        });
        if (!anyValidParent) shouldFlag = true;
      }
    }

    if (shouldFlag) invalid.add(node.id);
  }

  return invalid;
}

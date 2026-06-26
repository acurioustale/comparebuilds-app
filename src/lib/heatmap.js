// ─── Heatmap stats ────────────────────────────────────────────────────────────
//
// Pure adoption-counting and rarity-tier logic for the multi-build heatmap.
// Extracted from HeatmapTree for unit testing; the colour/label tables stay with
// the component since they are presentation.

/**
 * Maps an adoption count (how many builds picked a node) to a rarity tier.
 * @param {number} count  builds that selected the node
 * @param {number} total  total builds compared
 */
export function rarityTier(count, total) {
  if (count === 0) return "poor";
  const r = count / total;
  if (r === 1.0) return "legendary";
  if (r >= 0.75) return "epic";
  if (r >= 0.5) return "rare";
  return "uncommon";
}

/**
 * Whether a node is *contested* — picked by some builds but not all.
 * @param {number} count  builds that selected the node
 * @param {number} total  total builds compared
 */
export function isContested(count, total) {
  return count > 0 && count < total;
}

/**
 * The heatmap's notion of a "change" for the changes-only filter: a node the
 * builds didn't all treat the same way. That means either split adoption, or a
 * choice node every build takes but where the picks diverge. Nodes all builds
 * take identically (or none take) are agreement and get dimmed.
 *
 * Rank isn't tracked per build in the heatmap stats, so equal adoption of a
 * ranked node reads as agreement even if the invested points differ — consistent
 * with the heatmap being an adoption view rather than a rank view.
 *
 * @param {number} count               builds that selected the node
 * @param {number} total               total builds compared
 * @param {(number|null)[]} choiceVotes per-build entryChosen (null = not picked)
 */
export function isDivergent(count, total, choiceVotes = []) {
  if (isContested(count, total)) return true;
  if (count === total) {
    const picks = choiceVotes.filter((v) => v != null);
    return picks.some((v) => v !== picks[0]);
  }
  return false;
}

/**
 * For each node, computes how many builds include it, which choice each build
 * picked, and which builds took it at all.
 *
 * `takenBy` is tracked separately from `choiceVotes` because a `null` vote is
 * ambiguous on its own: a build that skipped the node and a build that took a
 * non-choice node both record `null`. The tooltip needs to name the builds that
 * took a node, so it relies on `takenBy`, not the votes.
 *
 * @param {object[]} builds   Array of parsed builds ({ nodes: Record<id, {pointsInvested, entryChosen}> })
 * @param {object[]} allNodes Full spec node list from treeData.nodes
 * @returns {Record<number, { count: number, choiceVotes: (number|null)[], takenBy: boolean[] }>}
 *   count: how many builds selected this node (alreadyGranted nodes = totalBuilds)
 *   choiceVotes: per-build entryChosen (null if that build didn't pick this node)
 *   takenBy: per-build flag for whether that build took the node (granted = all true)
 */
export function computeStats(builds, allNodes) {
  const total = builds.length;
  const stats = {};

  for (const node of allNodes) {
    if (node.alreadyGranted) {
      stats[node.id] = {
        count: total,
        choiceVotes: builds.map(() => null),
        takenBy: builds.map(() => true),
      };
      continue;
    }

    let count = 0;
    const choiceVotes = [];
    const takenBy = [];
    for (const b of builds) {
      const sel = b.nodes[node.id];
      if (sel) {
        count++;
        choiceVotes.push(sel.entryChosen ?? null);
        takenBy.push(true);
      } else {
        choiceVotes.push(null);
        takenBy.push(false);
      }
    }

    stats[node.id] = { count, choiceVotes, takenBy };
  }

  return stats;
}

/**
 * Returns the tiers that actually appear for a given build count, with their
 * count ranges, for the legend.
 */
export function computeLegendTiers(n) {
  if (n === 0) return [];

  // Group counts by tier
  const tierCounts = {};
  for (let c = 0; c <= n; c++) {
    const t = rarityTier(c, n);
    if (!tierCounts[t]) tierCounts[t] = [];
    tierCounts[t].push(c);
  }

  const order = ["legendary", "epic", "rare", "uncommon", "poor"];
  const result = [];

  for (const tier of order) {
    const counts = tierCounts[tier];
    if (!counts) continue;
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    const rangeLabel = min === max ? `${min}/${n}` : `${min}–${max}/${n}`;
    result.push({ tier, rangeLabel });
  }

  return result;
}

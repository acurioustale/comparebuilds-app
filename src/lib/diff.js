// ─── Build diff logic ─────────────────────────────────────────────────────────
//
// Pure comparison of two parsed builds. Extracted from SideBySideDiff so it can
// be unit-tested without rendering a component.

/**
 * Returns a human-readable label for what a build selected on a given node.
 * Used in the diff summary panel.
 *
 * @param {object} node Spec node definition from treeData.nodes
 * @param {{ pointsInvested: number, entryChosen: number|null }|null} sel Selection entry
 * @returns {string|null} Human-readable selection label
 */
export function selectionLabel(node, sel) {
  if (!sel) return null;
  if (node.type === "choice") {
    // A selected choice node always carries an entryChosen; guard the unknown
    // case (corrupt/partial data) by naming the node rather than faking
    // "option 1" (null + 1), which would mislabel it as the first option.
    if (sel.entryChosen == null) return node.name;
    const ch = node.choices[sel.entryChosen];
    const name = ch?.name ?? `option ${sel.entryChosen + 1}`;
    // If a chosen option is itself multi-rank, show the rank against THAT
    // option's maxRanks, not the node-level field (which can differ). No current
    // choice option is multi-rank, so this is output-neutral today; it keeps the
    // denominator correct should the data ever gain ranked choice options.
    const optMax = ch?.maxRanks ?? 1;
    return optMax > 1 ? `${name} (${sel.pointsInvested}/${optMax})` : name;
  }
  if (node.type === "apex" || node.maxRanks > 1) {
    return `${node.name} (${sel.pointsInvested}/${node.maxRanks})`;
  }
  return node.name;
}

/**
 * Computes the diff between two parsed builds.
 *
 * @param {Record<number, { pointsInvested: number, entryChosen: number|null }>} nodesA
 * @param {Record<number, { pointsInvested: number, entryChosen: number|null }>} nodesB
 * @param {object[]} allNodes  Full spec node list from treeData.nodes
 * @returns {{
 *   highlights: Record<number, 'a-only'|'b-only'|'diff'>,
 *   aOnly: object[],
 *   bOnly: object[],
 *   differing: object[]
 * }}
 */
export function computeDiff(nodesA, nodesB, allNodes) {
  const nodeById = {};
  for (const n of allNodes) nodeById[n.id] = n;

  const highlights = {};
  const aOnly = [];
  const bOnly = [];
  const differing = [];

  const allIds = new Set([
    ...Object.keys(nodesA).map(Number),
    ...Object.keys(nodesB).map(Number),
  ]);

  for (const id of allIds) {
    const node = nodeById[id];
    if (!node) continue;
    if (node.alreadyGranted) continue; // always present in both builds

    const selA = nodesA[id];
    const selB = nodesB[id];

    if (selA && !selB) {
      highlights[id] = "a-only";
      aOnly.push({ id, node, selA, selB: null });
    } else if (!selA && selB) {
      highlights[id] = "b-only";
      bOnly.push({ id, node, selA: null, selB });
    } else if (selA && selB) {
      const rankDiff = selA.pointsInvested !== selB.pointsInvested;
      const choiceDiff = selA.entryChosen !== selB.entryChosen;
      if (rankDiff || choiceDiff) {
        highlights[id] = "diff";
        differing.push({ id, node, selA, selB });
      }
    }
  }

  // Sort each group by tree section (class → spec → hero), then posY, then posX
  const sectionOrder = { class: 0, spec: 1, hero: 2 };
  const sortEntries = (arr) =>
    arr.sort((a, b) => {
      const sa = sectionOrder[a.node.treeType] ?? 3;
      const sb = sectionOrder[b.node.treeType] ?? 3;
      if (sa !== sb) return sa - sb;
      if (a.node.posY !== b.node.posY) return a.node.posY - b.node.posY;
      return a.node.posX - b.node.posX;
    });

  return {
    highlights,
    aOnly: sortEntries(aOnly),
    bOnly: sortEntries(bOnly),
    differing: sortEntries(differing),
  };
}

/**
 * A short, human-readable label for a recognisable trade-off between two
 * builds' selections on the same node — rendered alongside the node name in
 * the 2-build diff summary. Deliberately narrow: only the two patterns
 * concrete enough to name without guessing —
 *
 *   - a choice node both builds took, but picked different options
 *     ("Option X → Option Y")
 *   - a choice node or a capstone (apex node) present in one build and absent
 *     in the other ("dropped" / "gained", A → B) — both are recognisable picks
 *     where which option was taken matters, so they're labelled alike.
 *
 * Everything else (rank-only changes, ordinary non-apex/non-choice nodes only
 * one build took) returns null rather than mislabelling.
 *
 * @param {object} node Spec node definition
 * @param {{ pointsInvested: number, entryChosen: number|null }|null} selA
 * @param {{ pointsInvested: number, entryChosen: number|null }|null} selB
 * @returns {string|null}
 */
export function differenceLabel(node, selA, selB) {
  if (node.type === "choice" && selA && selB) {
    const nameA = node.choices?.[selA.entryChosen]?.name;
    const nameB = node.choices?.[selB.entryChosen]?.name;
    if (nameA && nameB && nameA !== nameB) return `${nameA} → ${nameB}`;
    return null;
  }
  // A choice or apex node present in exactly one build: label it gained/dropped
  // for parity — a one-sided choice is as much a recognisable pick as a capstone.
  if (node.type === "apex" || node.type === "choice") {
    if (selA && !selB) return "dropped";
    if (!selA && selB) return "gained";
  }
  return null;
}

const SECTION_LABELS = { class: "Class", spec: "Spec", hero: "Hero" };
const SECTION_ORDER = ["class", "spec", "hero"];

/**
 * Buckets a flat list of entries by their node's tree section (class/spec/
 * hero), in that display order, dropping empty sections. Each entry must
 * carry a `.node` with a `.treeType`; entries with an unrecognised treeType
 * are dropped rather than silently mis-bucketed. Order within a bucket is
 * preserved from the input.
 *
 * Extracted as pure logic (rather than computed inline in DiffSummaryTable)
 * so the "what differs where" grouping is unit-tested and can't drift from
 * the section labels/order used elsewhere.
 *
 * @param {Array<{node: {treeType: string}}>} entries
 * @returns {Array<{section: string, label: string, entries: object[]}>}
 */
export function groupBySection(entries) {
  const buckets = { class: [], spec: [], hero: [] };
  for (const entry of entries) {
    buckets[entry.node?.treeType]?.push(entry);
  }
  return SECTION_ORDER.map((section) => ({
    section,
    label: SECTION_LABELS[section],
    entries: buckets[section],
  })).filter((group) => group.entries.length > 0);
}

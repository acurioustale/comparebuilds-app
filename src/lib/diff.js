// ─── Build diff logic ─────────────────────────────────────────────────────────
//
// Pure comparison of two parsed builds. Extracted from SideBySideDiff so it can
// be unit-tested without rendering a component.

// The three tree sections in display order — the single source of truth for
// both the diff sort (sortEntries below) and the summary-table grouping
// (groupBySection), so the two can't order sections differently. SECTION_RANK
// is derived from the array; an unrecognised section sorts last.
const SECTION_ORDER = ["class", "spec", "hero"];
const SECTION_LABELS = { class: "Class", spec: "Spec", hero: "Hero" };
const SECTION_RANK = Object.fromEntries(SECTION_ORDER.map((s, i) => [s, i]));

/**
 * Resolves the name of the option a build picked on a choice node, or null when
 * the pick is unknown (a corrupt/partial parse can leave entryChosen null on a
 * taken choice node) or out of range. Every label site funnels the "which option,
 * and does it exist" rule through here so they can't diverge on how they treat an
 * unknown pick — the parse/label mismatch the summary table would otherwise risk.
 *
 * @param {object} node Spec node definition from treeData.nodes
 * @param {number|null} entryChosen The build's chosen option index
 * @returns {string|null} The chosen option's name, or null
 */
export function chosenOptionName(node, entryChosen) {
  if (entryChosen == null) return null;
  return node.choices?.[entryChosen]?.name ?? null;
}

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
    // Regular choice nodes carry name:null (their identity is their two options,
    // e.g. an apex-with-choices keeps a name but a plain choice does not), so fall
    // back to the option names joined rather than returning a blank cell.
    if (sel.entryChosen == null) {
      if (node.name) return node.name;
      const opts = node.choices?.map((c) => c?.name).filter(Boolean);
      return opts && opts.length ? opts.join(" / ") : null;
    }
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
      // Choice picks agree only when both are known (non-null) and equal. An
      // unknown pick (entryChosen null from a corrupt/partial parse) can't be
      // assumed to match, so it diverges — the same rule heatmap.isDivergent
      // applies, so the 2-build diff and the 3+-build heatmap classify an
      // unknown choice pick identically for the changes-only filter. Scoped to
      // choice nodes: every other node type always records a null pick, which is
      // genuine agreement, not a divergence.
      const choiceDiff =
        node.type === "choice" &&
        (selA.entryChosen == null ||
          selB.entryChosen == null ||
          selA.entryChosen !== selB.entryChosen);
      if (rankDiff || choiceDiff) {
        highlights[id] = "diff";
        differing.push({ id, node, selA, selB });
      }
    }
  }

  // Sort each group by tree section (class → spec → hero), then posY, then posX
  const sortEntries = (arr) =>
    arr.sort((a, b) => {
      const sa = SECTION_RANK[a.node.treeType] ?? SECTION_ORDER.length;
      const sb = SECTION_RANK[b.node.treeType] ?? SECTION_ORDER.length;
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
    // Both builds took the node; they agree only when both picks are KNOWN and
    // equal. An unknown pick (entryChosen null from a corrupt/partial parse)
    // can't be assumed to match — including two unknowns, which `null === null`
    // would otherwise read as agreement. computeDiff flags that both-unknown pair
    // as differing (mirroring heatmap.isDivergent), so labelling it "? → ?" keeps
    // the summary row from appearing in the diff with no trade-off text.
    if (
      selA.entryChosen != null &&
      selB.entryChosen != null &&
      selA.entryChosen === selB.entryChosen
    )
      return null;
    const nameA = chosenOptionName(node, selA.entryChosen) ?? "?";
    const nameB = chosenOptionName(node, selB.entryChosen) ?? "?";
    return `${nameA} → ${nameB}`;
  }
  // A choice or apex node present in exactly one build: label it gained/dropped
  // for parity — a one-sided choice is as much a recognisable pick as a capstone.
  if (node.type === "apex" || node.type === "choice") {
    if (selA && !selB) return "dropped";
    if (!selA && selB) return "gained";
  }
  return null;
}

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

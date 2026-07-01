import { useEffect, useMemo } from "react";
import { computeDiff } from "../lib/diff";
import { computeStats, isContested, isDivergent } from "../lib/heatmap";

// Display name for a node: its own name, or a choice node's options joined.
/**
 * @param {object} node Spec node object
 * @returns {string} Display name
 */
function nodeName(node) {
  return (
    node.name ||
    (node.choices
      ? node.choices.map((c) => c.name).join(" / ")
      : "Unnamed Talent")
  );
}

// Concise per-build cell value: chosen option, rank fraction, or a not-taken dash.
/**
 * @param {object} node Spec node object
 * @param {{ pointsInvested: number, entryChosen: number|null }|null} sel Selection object
 * @returns {string} Cell display value
 */
function cellValue(node, sel) {
  if (!sel) return "—";
  if (node.type === "choice") {
    return node.choices?.[sel.entryChosen]?.name ?? "Selected";
  }
  return `${sel.pointsInvested}/${node.maxRanks}`;
}

/**
 * Summary table of where builds differ. The "what counts as a difference" logic
 * is delegated to the shared comparison libs so it can't drift from the trees:
 *   - 2 builds  → diff.js computeDiff (added / removed / changed rank-or-choice)
 *   - 3+ builds → heatmap.js computeStats + isDivergent, which also flags choice
 *     nodes every build takes but where the picks diverge (a case the old inline
 *     count-based check missed).
 * Hovering a row spotlights that node in the tree via SpotlightContext.
 *
 * @param {object} props
 * @param {object} props.treeData Spec tree data object
 * @param {Array<{ parsed: object, label: string }>} props.valid Array of valid builds
 * @param {number|null} [props.spotlightId] Currently spotlighted node id
 * @param {function} props.setSpotlightId Spotlight setter callback
 * @returns {import("react").JSX.Element|null}
 */
export default function DiffSummaryTable({
  treeData,
  valid,
  spotlightId = null,
  setSpotlightId,
}) {
  const isDiffMode = valid?.length === 2;

  const rows = useMemo(() => {
    if (!treeData?.nodes || !valid || valid.length < 2) return [];

    if (valid.length === 2) {
      const [a, b] = valid;
      const { aOnly, bOnly, differing } = computeDiff(
        a.parsed.nodes,
        b.parsed.nodes,
        treeData.nodes,
      );
      // computeDiff already sorts each group by section then position.
      return [...aOnly, ...bOnly, ...differing].map(
        ({ id, node, selA, selB }) => ({
          id,
          node,
          valA: cellValue(node, selA),
          valB: cellValue(node, selB),
        }),
      );
    }

    const total = valid.length;
    const stats = computeStats(
      valid.map((v) => v.parsed),
      treeData.nodes,
    );
    const out = [];
    for (const node of treeData.nodes) {
      if (node.alreadyGranted) continue;
      const s = stats[node.id];
      if (!s || !isDivergent(s.count, total, s.choiceVotes)) continue;
      out.push({
        id: node.id,
        node,
        count: s.count,
        total,
        // Every build took it, but the chosen options differ.
        choiceSplit: !isContested(s.count, total),
      });
    }
    // Most contested first: balanced adoption (count nearest total/2) ranks
    // highest; full-adoption choice splits fall to the bottom. Stable by the
    // tree-order iteration above otherwise.
    out.sort(
      (x, y) =>
        Math.min(y.count, y.total - y.count) -
        Math.min(x.count, x.total - x.count),
    );
    return out;
  }, [treeData, valid]);

  // Row hover sets the spotlight and onMouseLeave clears it — but if the builds
  // change while a row is hovered so that row drops out of `rows` (its difference
  // resolved, or it was removed), onMouseLeave never fires and the spotlight
  // would stay pinned to a node no longer in the table, dimming the whole tree.
  // Clear it whenever the spotlighted id isn't a current row.
  useEffect(() => {
    if (spotlightId != null && !rows.some((r) => r.id === spotlightId)) {
      setSpotlightId?.(null);
    }
  }, [rows, spotlightId, setSpotlightId]);

  if (rows.length === 0) return null;

  return (
    <div className="mt-6 max-w-4xl mx-auto">
      <div className="wow-panel p-4 rounded shadow-lg border border-[#3a2e1a]">
        <h2 className="text-wow-gold text-sm uppercase tracking-widest mb-3 select-none flex items-center gap-2">
          <span>{isDiffMode ? "Diff Summary" : "Contested Talents"}</span>
          <span className="text-[11px] text-wow-muted lowercase tracking-normal">
            (hover to spotlight in tree)
          </span>
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-[#3a2e1a] text-wow-muted">
                <th className="py-2 px-3 font-semibold">Talent</th>
                {isDiffMode ? (
                  <>
                    <th className="py-2 px-3 font-semibold">
                      {valid[0].label}
                    </th>
                    <th className="py-2 px-3 font-semibold">
                      {valid[1].label}
                    </th>
                  </>
                ) : (
                  <th className="py-2 px-3 font-semibold">Adoption</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#3a2e1a]/50">
              {rows.map((row) => (
                <tr
                  key={row.id}
                  onMouseEnter={() => setSpotlightId?.(row.id)}
                  onMouseLeave={() => setSpotlightId?.(null)}
                  className="hover:bg-[#251b0d]/50 transition-colors cursor-default"
                >
                  <td className="py-2.5 px-3 font-medium text-wow-gold">
                    {nodeName(row.node)}
                  </td>
                  {isDiffMode ? (
                    <>
                      <td className="py-2.5 px-3 text-wow-text">{row.valA}</td>
                      <td className="py-2.5 px-3 text-wow-text">{row.valB}</td>
                    </>
                  ) : (
                    <td className="py-2.5 px-3 text-wow-text font-mono">
                      {row.choiceSplit
                        ? `picks differ (${row.count}/${row.total})`
                        : `${row.count}/${row.total} builds`}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

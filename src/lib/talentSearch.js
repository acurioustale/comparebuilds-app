// ─── Talent search ────────────────────────────────────────────────────────────
//
// Pure matcher for the search/filter box: given a query and a spec's node list,
// returns the set of node ids whose name (or, for choice nodes, any option name)
// contains the query, case-insensitively. An empty/whitespace query returns an
// empty set, which callers treat as "search inactive".

/**
 * @param {string} query
 * @param {object[]} nodes  treeData.nodes
 * @returns {Set<number>}
 */
export function matchNodeIds(query, nodes) {
  const q = (query ?? '').trim().toLowerCase()
  const ids = new Set()
  if (q.length === 0 || !Array.isArray(nodes)) return ids

  for (const n of nodes) {
    const names = [n.name]
    if (Array.isArray(n.choices)) {
      for (const c of n.choices) names.push(c?.name)
    }
    if (names.some((nm) => typeof nm === 'string' && nm.toLowerCase().includes(q))) {
      ids.add(n.id)
    }
  }
  return ids
}

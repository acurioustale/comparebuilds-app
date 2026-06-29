// ─── Talent search ────────────────────────────────────────────────────────────
//
// Pure matcher for the search/filter box: given a query and a spec's node list,
// returns the set of node ids whose name or description text contains the query,
// case-insensitively — including choice options (name + description) and an apex
// node's per-rank descriptions. An empty/whitespace query returns an empty set,
// which callers treat as "search inactive".
//
// Descriptions are sanitised tooltip HTML, so they carry entities (e.g. `&#39;`
// or `&#x27;` for an apostrophe) and the occasional tag. Each node's searchable
// text is normalised — tags stripped, entities decoded, whitespace collapsed,
// lowercased — so a query like "attacker's" matches the stored "attacker&#39;s".
// The query is normalised the same way. The per-node text is memoised by
// node-list identity so the regex work happens once per loaded spec, not on
// every keystroke.

const NAMED_ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

// Decode a numeric character reference, guarding against out-of-range values so
// a malformed entity returns null (caller leaves the literal text) rather than
// throwing from String.fromCodePoint.
function fromCodePoint(n) {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff
    ? String.fromCodePoint(n)
    : null;
}

function decodeEntities(s) {
  return s.replace(/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/gi, (m) => {
    const named = NAMED_ENTITIES[m.toLowerCase()];
    if (named !== undefined) return named;
    const dec = /^&#(\d+);$/.exec(m);
    if (dec) return fromCodePoint(Number(dec[1])) ?? m;
    const hex = /^&#x([0-9a-f]+);$/i.exec(m);
    if (hex) return fromCodePoint(parseInt(hex[1], 16)) ?? m;
    return m;
  });
}

// Strip tags, decode entities, collapse whitespace, lowercase.
function normalise(text) {
  if (typeof text !== "string") return "";
  return decodeEntities(text.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// node id → normalised searchable text, memoised by node-list identity.
const indexCache = new WeakMap();

function searchIndex(nodes) {
  const cached = indexCache.get(nodes);
  if (cached) return cached;
  const index = new Map();
  for (const n of nodes) {
    const parts = [n.name, n.description];
    if (Array.isArray(n.choices)) {
      for (const c of n.choices) parts.push(c?.name, c?.description);
    }
    if (Array.isArray(n.ranks)) {
      for (const r of n.ranks) parts.push(r?.description);
    }
    index.set(n.id, parts.map(normalise).join(" "));
  }
  indexCache.set(nodes, index);
  return index;
}

/**
 * @param {string} query
 * @param {object[]} nodes  treeData.nodes
 * @returns {Set<number>}
 */
export function matchNodeIds(query, nodes) {
  const q = normalise(query);
  const ids = new Set();
  if (q.length === 0 || !Array.isArray(nodes)) return ids;

  for (const [id, text] of searchIndex(nodes)) {
    if (text.includes(q)) ids.add(id);
  }
  return ids;
}

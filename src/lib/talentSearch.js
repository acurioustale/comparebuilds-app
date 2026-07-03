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
// The query is normalised the same way EXCEPT tag-stripping: it is plain user
// text, so an angle bracket the user typed (e.g. "<5 yds") must survive to match
// the decoded tooltip text. The per-node text is memoised by node-list identity
// so the regex work happens once per loaded spec, not on every keystroke.

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
/**
 * @param {number} n Numeric character code
 * @returns {string|null} Decoded character or null
 */
function fromCodePoint(n) {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff
    ? String.fromCodePoint(n)
    : null;
}

/**
 * @param {string} s String containing HTML entities
 * @returns {string} Decoded string
 */
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

// Decode entities, collapse whitespace, lowercase. Shared by the query and the
// index so both land in the same comparable form.
/**
 * @param {string} text Raw text string
 * @returns {string} Normalised string
 */
function normaliseText(text) {
  if (typeof text !== "string") return "";
  return decodeEntities(text).replace(/\s+/g, " ").trim().toLowerCase();
}

// Index text is HTML, so strip tags first (markup isn't searchable content).
// This must NOT run on the query — the query is plain user text, and stripping
// `<...>` from it would drop any angle-bracketed span the user typed (e.g.
// "<5 yds"), so it could never match the decoded "<5 yds" stored in a tooltip.
/**
 * @param {string} text Raw HTML text string
 * @returns {string} Normalised string
 */
function normalise(text) {
  if (typeof text !== "string") return "";
  return normaliseText(text.replace(/<[^>]*>/g, " "));
}

// node id → normalised searchable text, memoised by node-list identity.
const indexCache = new WeakMap();

/**
 * @param {object[]} nodes Spec node list
 * @returns {Map<number, string>} Map of node id → normalised searchable text
 */
function searchIndex(nodes) {
  const cacheKey = nodes[0] ?? nodes;
  const cached = indexCache.get(cacheKey);
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
  indexCache.set(cacheKey, index);
  return index;
}

/**
 * @param {string} query Search query
 * @param {object[]} nodes treeData.nodes
 * @returns {Set<number>} Set of matching node IDs
 */
export function matchNodeIds(query, nodes) {
  // The query is plain text — normalise WITHOUT tag-stripping so an angle
  // bracket the user typed survives to match the decoded index text.
  const q = normaliseText(query);
  const ids = new Set();
  if (q.length === 0 || !Array.isArray(nodes)) return ids;

  for (const [id, text] of searchIndex(nodes)) {
    if (text.includes(q)) ids.add(id);
  }
  return ids;
}

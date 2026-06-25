// ─── Client-side share links ──────────────────────────────────────────────────
//
// Encodes builds (and optional per-slot names) into a URL-hash payload so a build
// can be shared with no server round-trip — no DB row, no rate limit, works
// offline. This is the sibling of the server short-link API (api/share.php): the
// server link is the pretty, persistent option; this is the instant one.
//
// The payload is base64url(JSON) of `{ b: string[], n?: string[] }`. Build
// strings are themselves base64, so wrapping the JSON in base64url keeps the
// whole token within the URL-safe alphabet (A–Z a–z 0–9 - _) with no escaping.
// JSON (rather than a bespoke delimiter format) keeps names — which may contain
// arbitrary Unicode — unambiguous.

// Hard ceiling on decoded entries, purely to reject pathological payloads; the
// store's addBuild enforces the real MAX_BUILDS/MAX_BUILD_LEN limits per build.
const SANITY_MAX_ENTRIES = 50

// UTF-8-safe base64url. btoa/atob operate on Latin-1, so route bytes through
// TextEncoder/TextDecoder to survive non-ASCII build names.
function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(token) {
  const b64 = token.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/**
 * Encodes builds + optional names into a hash token (the part after `#b=`).
 * @param {{ builds: string[], names?: (string|null|undefined)[] }} input
 * @returns {string}
 */
export function encodeBuildsHash({ builds, names }) {
  const payload = { b: builds }
  // Only carry names when at least one is set, to keep links short.
  if (Array.isArray(names) && names.some((n) => n)) {
    payload.n = builds.map((_, i) => names[i] ?? '')
  }
  return b64urlEncode(JSON.stringify(payload))
}

/**
 * Decodes a hash token back into builds + names. Returns null for anything
 * malformed so the caller can fall back gracefully.
 * @param {string} token  The value after `#b=`.
 * @returns {{ builds: string[], names: string[] } | null}
 */
export function decodeBuildsHash(token) {
  if (typeof token !== 'string' || token.length === 0) return null
  try {
    const obj = JSON.parse(b64urlDecode(token))
    if (!obj || !Array.isArray(obj.b)) return null
    const builds = obj.b.filter((s) => typeof s === 'string').slice(0, SANITY_MAX_ENTRIES)
    if (builds.length === 0) return null
    const names = builds.map((_, i) =>
      Array.isArray(obj.n) && typeof obj.n[i] === 'string' ? obj.n[i] : '',
    )
    return { builds, names }
  } catch {
    return null
  }
}

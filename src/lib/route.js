// ─── Entry-route resolution ───────────────────────────────────────────────────
//
// Single place that decides what a page load should do, from the URL. Today that
// is purely hash-based; it is the seam later phases extend to path-based routes
// (server share pages /s/<id>, prerendered spec pages /<class>/<spec>).
//
//   #<6 alphanumerics>  → a server short-link id      → { kind: 'server-share', id }
//   #b=<token>          → a client-side instant link  → { kind: 'client-share', token }
//   anything else       → restore from local storage  → { kind: 'local' }

const SHARE_ID_RE = /^[A-Za-z0-9]{6}$/

/**
 * @param {{ hash?: string }} [location]  Defaults to window.location.
 * @returns {{ kind: 'server-share', id: string }
 *          | { kind: 'client-share', token: string }
 *          | { kind: 'local' }}
 */
export function resolveRoute(location = typeof window !== 'undefined' ? window.location : { hash: '' }) {
  const hash = (location.hash || '').replace(/^#/, '')

  if (hash.startsWith('b=')) {
    return { kind: 'client-share', token: hash.slice(2) }
  }
  if (SHARE_ID_RE.test(hash)) {
    return { kind: 'server-share', id: hash }
  }
  return { kind: 'local' }
}

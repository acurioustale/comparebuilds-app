// ─── Entry-route resolution ───────────────────────────────────────────────────
//
// Single place that decides what a page load should do, from the URL.
//
//   #<6 alphanumerics>     → a server short-link id        → { kind: 'server-share', id }
//   #b=<token>             → a client-side instant link    → { kind: 'client-share', token }
//   /<class>/<spec>        → a prerendered spec landing    → { kind: 'spec-page', specId }
//   anything else          → restore from local storage    → { kind: 'local' }
//
// A share in the hash always wins over a spec path (an explicit share link should
// load its build even if opened from a spec URL).

import classesIndex from "../data/classes.json";

// The 6-char share-id format. Mirrored in api/share.php (valid_share_id) and
// api/og.php; shareIdParity.test.js pins all three together across the two
// languages so the SPA route, the share page, and its OG image can't drift.
const SHARE_ID_RE = /^[A-Za-z0-9]{6}$/;

// slug ("death_knight") ↔ URL segment ("death-knight").
const toSegment = (slug) => slug.replaceAll("_", "-");

// "<class>/<spec>" segment pair → specId, built once from the class index.
const SPEC_BY_PATH = new Map();
for (const cls of classesIndex) {
  if (!cls.implemented) continue;
  for (const spec of cls.specs) {
    SPEC_BY_PATH.set(`${toSegment(cls.name)}/${toSegment(spec.name)}`, spec.id);
  }
}

/** Returns the specId for a "/<class>/<spec>" pathname, or null. */
export function specIdForPath(pathname) {
  const key = (pathname || "").replace(/^\/+|\/+$/g, "").toLowerCase();
  return SPEC_BY_PATH.has(key) ? SPEC_BY_PATH.get(key) : null;
}

/**
 * @param {{ hash?: string, pathname?: string }} [location]  Defaults to window.location.
 * @returns {{ kind: 'server-share', id: string }
 *          | { kind: 'client-share', token: string }
 *          | { kind: 'spec-page', specId: number }
 *          | { kind: 'local' }}
 */
export function resolveRoute(
  location = typeof window !== "undefined"
    ? window.location
    : { hash: "", pathname: "" },
) {
  const hash = (location.hash || "").replace(/^#/, "");

  if (hash.startsWith("b=")) {
    return { kind: "client-share", token: hash.slice(2) };
  }
  if (SHARE_ID_RE.test(hash)) {
    return { kind: "server-share", id: hash };
  }

  const specId = specIdForPath(location.pathname || "");
  if (specId != null) {
    return { kind: "spec-page", specId };
  }

  return { kind: "local" };
}

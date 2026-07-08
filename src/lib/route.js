// ─── Entry-route resolution ───────────────────────────────────────────────────
//
// Single place that decides what a page load should do, from the URL.
//
//   #<8–16 alphanumerics>   → a server short-link id        → { kind: 'server-share', id }
//   /<class>/<spec>         → a prerendered spec landing    → { kind: 'spec-page', specId }
//   anything else           → restore from local storage    → { kind: 'local' }
//
// A share in the hash always wins over a spec path (an explicit share link should
// load its build even if opened from a spec URL).

import classesIndex from "../data/classes.json";

// The 8–16 char share-id format. Mirrored in api/share.php (valid_share_id) and
// api/og.php; shareIdParity.test.js pins all three together across the two
// languages so the SPA route, the share page, and its OG image can't drift.
// Exported so shareLink.js validates the API's returned id against the same
// contract rather than a duplicated pattern.
export const SHARE_ID_RE = /^[A-Za-z0-9]{8,16}$/;
const TRIM_SLASHES_RE = /^\/+|\/+$/g;
const LEADING_HASH_RE = /^#/;

// slug ("death_knight") ↔ URL segment ("death-knight").
const toSegment = (slug) => slug.replaceAll("_", "-");

// "<class>/<spec>" segment pair → specId, built once from the class index.
// Keys are lowercased to match specIdForPath's lowercased lookup, so a class or
// spec name with any uppercase letter still resolves instead of silently missing.
const SPEC_BY_PATH = new Map();
for (const cls of classesIndex) {
  if (!cls.implemented) continue;
  for (const spec of cls.specs) {
    SPEC_BY_PATH.set(
      `${toSegment(cls.name)}/${toSegment(spec.name)}`.toLowerCase(),
      spec.id,
    );
  }
}

/**
 * Returns the specId for a "/<class>/<spec>" pathname, or null.
 * @param {string} pathname URL pathname
 * @returns {number|null} Spec ID or null
 */
export function specIdForPath(pathname) {
  const key = (pathname || "").replace(TRIM_SLASHES_RE, "").toLowerCase();
  return SPEC_BY_PATH.has(key) ? SPEC_BY_PATH.get(key) : null;
}

/**
 * @param {{ hash?: string, pathname?: string }} [location] Defaults to window.location.
 * @returns {{ kind: 'server-share', id: string }
 *          | { kind: 'spec-page', specId: number }
 *          | { kind: 'local' }} Route resolution object
 */
export function resolveRoute(
  location = typeof window !== "undefined"
    ? window.location
    : { hash: "", pathname: "" },
) {
  const hash = (location.hash || "").replace(LEADING_HASH_RE, "");

  if (SHARE_ID_RE.test(hash)) {
    return { kind: "server-share", id: hash };
  }

  const specId = specIdForPath(location.pathname || "");
  if (specId != null) {
    return { kind: "spec-page", specId };
  }

  return { kind: "local" };
}

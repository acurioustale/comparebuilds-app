/**
 * Identifies the retired icon-cache service worker and its caches.
 *
 * Earlier versions registered `public/sw.js`, which cached wow.zamimg.com icons
 * under `zamimg-*` keys. Icons are now served first-party from /talent-icons, so
 * the worker is gone and main.jsx unregisters it on the next visit.
 *
 * These predicates exist so that cleanup names what it retires. An unfiltered
 * sweep — unregister every worker, delete every cache key — happens to work
 * while this is the only thing that ever registered a worker or wrote a cache,
 * and silently breaks the first caching feature added after it, on every page
 * load, with nothing at the call site to explain why.
 *
 * Pure: string predicates over values the caller reads off the platform.
 */

/** Path of the retired worker script, as registered. */
export const RETIRED_WORKER_PATH = "/sw.js";

/** Key prefix of its caches: zamimg-icons-v*, zamimg-meta-v*. */
export const RETIRED_CACHE_PREFIX = "zamimg-";

/**
 * Whether a registration's script URL is the retired worker.
 *
 * Compares the resolved pathname, so an absolute URL, a path, and a URL
 * carrying a query or hash all answer the same — and a worker at a different
 * path (anything registered after this cleanup was written) is left alone.
 *
 * @param {string|null|undefined} scriptUrl The registration's script URL.
 * @param {string} [base] Base to resolve a relative URL against.
 * @returns {boolean}
 */
export function isRetiredWorker(scriptUrl, base = "http://localhost") {
  if (!scriptUrl) return false;
  try {
    return new URL(scriptUrl, base).pathname === RETIRED_WORKER_PATH;
  } catch {
    // Not a resolvable URL — not something this cleanup owns.
    return false;
  }
}

/**
 * Whether a Cache Storage key belongs to the retired worker.
 *
 * @param {string|null|undefined} key
 * @returns {boolean}
 */
export function isRetiredCache(key) {
  return typeof key === "string" && key.startsWith(RETIRED_CACHE_PREFIX);
}

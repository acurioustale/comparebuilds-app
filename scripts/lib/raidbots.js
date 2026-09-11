/**
 * scripts/lib/raidbots.js
 * -----------------------
 * Thin client for the public Raidbots static-data files
 * (https://www.raidbots.com/developers). Used only by the build-time checks;
 * never imported by the browser app.
 *
 * Why a SECOND source when Blizzard is the sole ingest: Raidbots generates its
 * files from the game client with SimC's casc/dbc tools, so it is an INDEPENDENT
 * derivation of the same upstream truth — a different toolchain reading the same
 * client. That makes it useful for exactly one thing the ingest can't do for
 * itself: confirm our build-string wire layout from outside our own code path.
 * It is never a source of record. Nothing here writes src/data/.
 *
 * Two properties make it worth wiring up at all:
 *   - No credentials. compareSources.js needs BLIZZARD_CLIENT_ID/SECRET, so it
 *     can't run on a fork PR. These files are plain public GETs.
 *   - PTR and beta channels. The `ptr`/`beta` environments carry the next
 *     patch's data, so a node-set change can be seen BEFORE it ships and breaks
 *     every committed build string.
 *
 * Raidbots asks that these files be cached locally, and they are large (talents
 * is ~3 MB), so responses land in scripts/.cache/raidbots/<env>/<contentHash>/
 * (gitignored), alongside the Blizzard caches.
 *
 * The cache is keyed by the channel's CONTENT HASH, not just by channel, and
 * that is load-bearing rather than tidy: a cache keyed by channel alone never
 * expires, so the moment Raidbots publishes a new build every consumer keeps
 * reading yesterday's copy and reports agreement it never actually checked —
 * a false green in exactly the case the checks exist for. metadata.json carries
 * the hash, is about a kilobyte, and is fetched uncached; a new upload changes
 * the hash and therefore misses the cache, while an unchanged one is served
 * from disk. That also keeps the daily job's traffic at ~1 KB instead of
 * re-pulling megabytes, which is what "please cache these files locally" is
 * asking for.
 *
 * The data is published as-is with no guarantee of accuracy — which is why it
 * only ever feeds a REPORT, never a write.
 *
 * Node-only (fs + global fetch). No external dependencies.
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { pruneSiblingDirs, writeFileAtomic } from "./blizzardApi.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_ROOT = join(__dirname, "..", ".cache", "raidbots");

const STATIC_BASE = "https://www.raidbots.com/static/data";

// The game-version channels Raidbots publishes. `live` is what committed data
// must agree with; `ptr`/`beta` are the early-warning channels.
export const ENVIRONMENTS = ["live", "ptr", "beta"];

/**
 * Resolve an environment name, rejecting anything outside the published set.
 *
 * The value reaches a URL path segment, so an unchecked one both builds a
 * nonsense request and would let a stray `../` walk the cache path. A typo like
 * `--env=lve` must fail loudly rather than 404 into a confusing error.
 */
export function assertEnvironment(env) {
  if (!ENVIRONMENTS.includes(env))
    throw new Error(
      `unknown Raidbots environment "${env}" (expected one of ${ENVIRONMENTS.join(", ")})`,
    );
  return env;
}

/**
 * GET one Raidbots static JSON file for an environment, with a disk cache.
 *
 * @param {string}  file            e.g. "talents.json"
 * @param {object}  [opts]
 * @param {string}  [opts.env]      game-version channel (default "live")
 * @param {boolean} [opts.cache]    read/write the disk cache (default true)
 * @param {Function}[opts.fetchImpl] injected for tests
 * @returns {Promise<any>} the parsed JSON
 */
export async function fetchRaidbotsJson(
  file,
  {
    env = "live",
    cache = true,
    version = null,
    cacheRoot = CACHE_ROOT,
    fetchImpl = fetch,
  } = {},
) {
  assertEnvironment(env);
  // Without a version to key on there is nothing that can invalidate the entry,
  // so don't write one at all — a permanently stale file is worse than a refetch.
  const useCache = cache && Boolean(version);
  const envDir = join(cacheRoot, env);
  const cacheDir = join(envDir, String(version));
  const cacheFile = join(cacheDir, file);
  if (useCache && existsSync(cacheFile))
    return JSON.parse(readFileSync(cacheFile, "utf8"));

  const url = `${STATIC_BASE}/${env}/${file}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const text = await res.text();
  // Parse BEFORE caching: a truncated or HTML error body must not be written to
  // the cache, or every later run would read the corrupt copy back and never
  // retry the fetch.
  const data = JSON.parse(text);
  if (useCache) {
    // Drop the previous build's directory: these are multi-megabyte files and
    // an superseded copy will never be read again.
    pruneSiblingDirs(envDir, String(version));
    mkdirSync(cacheDir, { recursive: true });
    writeFileAtomic(cacheFile, text);
  }
  return data;
}

/**
 * Fetch metadata.json — "data about the data" for a channel: which game build it
 * was generated from (`wowBuild`), a content hash, and when it was generated.
 *
 * Never cached. It is the freshness probe every other fetch keys off, so a
 * cached copy would answer with the version we already knew about — the one
 * question it exists to move past.
 */
export async function fetchMetadata(opts = {}) {
  return fetchRaidbotsJson("metadata.json", { ...opts, cache: false });
}

/**
 * Fetch talents.json — one entry per spec, each carrying `fullNodeOrder`:
 * Raidbots' own ordered node-id list for the class's build-string serialisation.
 *
 * Resolves the channel's content hash first (a ~1 KB request) and keys the cache
 * on it, so an unchanged upload costs that kilobyte instead of ~3 MB, and a
 * changed one can never be served from a stale entry.
 */
export async function fetchTalents(opts = {}) {
  const meta = await fetchMetadata(opts);
  return fetchRaidbotsJson("talents.json", {
    ...opts,
    version: meta.contentHash ?? meta.wowBuild ?? null,
  });
}

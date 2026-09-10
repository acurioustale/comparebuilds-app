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
 * is ~3 MB), so responses land in scripts/.cache/raidbots/<env>/ (gitignored),
 * alongside the Blizzard caches. Delete the directory to force a refetch.
 *
 * The data is published as-is with no guarantee of accuracy — which is why it
 * only ever feeds a REPORT, never a write.
 *
 * Node-only (fs + global fetch). No external dependencies.
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileAtomic } from "./blizzardApi.js";

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
  { env = "live", cache = true, fetchImpl = fetch } = {},
) {
  assertEnvironment(env);
  const cacheDir = join(CACHE_ROOT, env);
  const cacheFile = join(cacheDir, file);
  if (cache && existsSync(cacheFile))
    return JSON.parse(readFileSync(cacheFile, "utf8"));

  const url = `${STATIC_BASE}/${env}/${file}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const text = await res.text();
  // Parse BEFORE caching: a truncated or HTML error body must not be written to
  // the cache, or every later run would read the corrupt copy back and never
  // retry the fetch.
  const data = JSON.parse(text);
  if (cache) {
    mkdirSync(cacheDir, { recursive: true });
    writeFileAtomic(cacheFile, text);
  }
  return data;
}

/**
 * Fetch talents.json — one entry per spec, each carrying `fullNodeOrder`:
 * Raidbots' own ordered node-id list for the class's build-string serialisation.
 */
export async function fetchTalents(opts) {
  return fetchRaidbotsJson("talents.json", opts);
}

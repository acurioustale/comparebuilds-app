/**
 * scripts/lib/blizzardApi.js
 * --------------------------
 * Thin client for Blizzard's World of Warcraft Game Data API — the authoritative
 * upstream for talent data. Used only by the build-time ingest
 * (scripts/ingestBlizzard.js); never imported by the browser app.
 *
 * Auth is OAuth2 client-credentials: POST the client id/secret to the OAuth
 * endpoint for a bearer token (valid ~24h), then send it on every Game Data
 * request along with the required `static-{region}` namespace.
 *
 * Credentials (see .env.example) are resolved, in precedence order, from:
 *   1. a file named by BLIZZARD_CREDENTIALS_FILE (may live ANYWHERE — e.g. above
 *      the repo, the config.php analog for keeping secrets off the tree),
 *   2. a gitignored `.env` in the repo root,
 *   3. the process environment (CI sets BLIZZARD_CLIENT_ID/SECRET as secrets).
 * Nothing here is ever committed or deployed: scripts/ is build-time only.
 *
 * GET responses are cached on disk (scripts/.cache/blizzard/, gitignored) so
 * repeated verify runs are fast and stay well under the rate limit. Delete the
 * cache dir to force a refetch (e.g. after a game patch).
 *
 * Node-only (fs + global fetch). No external dependencies.
 */

import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
  rmSync,
} from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { createHash, randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const CACHE_DIR = join(__dirname, "..", ".cache", "blizzard");

/** Remove every entry under `parent` except `keep` — drops stale per-build caches. */
export function pruneSiblingDirs(parent, keep) {
  if (!existsSync(parent)) return;
  for (const name of readdirSync(parent))
    if (name !== keep)
      rmSync(join(parent, name), { recursive: true, force: true });
}

/**
 * Write `data` to `path` atomically: write to a unique temp file in the SAME
 * directory (so the rename stays on one filesystem) then rename it into place.
 * A rename is atomic, so an interrupted write (Ctrl-C, OOM, disk full) can never
 * leave a truncated file at `path` for the next run to choke on — the worst case
 * is a leftover temp file, which we unlink on failure. Used for the build-time
 * disk caches (GET JSON, DB2 CSV).
 */
export function writeFileAtomic(path, data) {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // temp file may not exist if writeFileSync itself failed — ignore
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Credential loading
// ---------------------------------------------------------------------------

/** Parse simple KEY=VALUE lines (ignoring blanks and `#` comments). */
function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * Resolve credentials from the layered sources without clobbering anything the
 * caller already exported. Returns { clientId, clientSecret, region }.
 */
export function loadCredentials(env = process.env) {
  const fromFiles = {};
  // Lowest precedence first so later sources override earlier ones.
  const candidates = [
    join(REPO_ROOT, ".env"),
    env.BLIZZARD_CREDENTIALS_FILE
      ? resolve(REPO_ROOT, env.BLIZZARD_CREDENTIALS_FILE)
      : null,
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path))
      Object.assign(fromFiles, parseEnv(readFileSync(path, "utf8")));
  }

  const pick = (key) => env[key] ?? fromFiles[key];
  const clientId = pick("BLIZZARD_CLIENT_ID");
  const clientSecret = pick("BLIZZARD_CLIENT_SECRET");
  const region = (pick("BLIZZARD_REGION") || "us").toLowerCase();

  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing Blizzard API credentials. Set BLIZZARD_CLIENT_ID and " +
        "BLIZZARD_CLIENT_SECRET in a gitignored .env (see .env.example), in a " +
        "file named by BLIZZARD_CREDENTIALS_FILE, or in the environment.",
    );
  }
  return { clientId, clientSecret, region };
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

const OAUTH_HOST = "https://oauth.battle.net/token";
const apiHost = (region) => `https://${region}.api.blizzard.com`;

export class BlizzardApi {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.cache=true]  read/write the on-disk GET cache
   * @param {string}  [opts.locale="en_US"]
   */
  constructor({ cache = true, locale = "en_US" } = {}) {
    const { clientId, clientSecret, region } = loadCredentials();
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.region = region;
    this.namespace = `static-${region}`;
    this.locale = locale;
    this.useCache = cache;
    this._token = null;
    this._build = null;
    // Build-scoped once resolvedBuild() runs, so a game patch (new build) gets a
    // fresh cache instead of serving stale responses under the same request URL.
    this.cacheDir = CACHE_DIR;
    if (cache) mkdirSync(this.cacheDir, { recursive: true });
  }

  async token() {
    if (this._token) return this._token;
    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString(
      "base64",
    );
    const res = await fetch(OAUTH_HOST, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      throw new Error(`OAuth token request failed: HTTP ${res.status}`);
    }
    const json = await res.json();
    this._token = json.access_token;
    return this._token;
  }

  /**
   * GET a Game Data resource. `path` is the API path (e.g.
   * "/data/wow/talent-tree/index"); namespace + locale are added automatically.
   * Absolute hrefs returned by the API are also accepted (their namespace is
   * normalised to the version-pinned one Blizzard hands back).
   *
   * @param {string} path
   * @param {Record<string,string|number>} [params]  extra query params
   * @returns {Promise<object>}
   */
  async get(path, params = {}) {
    const url = this._url(path, params);
    const cacheFile = this._cachePath(url);
    if (this.useCache && cacheFile && existsSync(cacheFile)) {
      return JSON.parse(readFileSync(cacheFile, "utf8"));
    }
    const json = await this._fetchJson(url);
    if (this.useCache && cacheFile) {
      writeFileAtomic(cacheFile, JSON.stringify(json));
    }
    return json;
  }

  /** Authenticated GET → JSON, no caching. */
  async _fetchJson(url, retried = false) {
    const token = await this.token();
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30000),
    });
    // The bearer token is cached for the process lifetime, so a long ingest can
    // outlive it (or hit clock skew / a revoked token). On a 401, drop the
    // cached token and re-authenticate once before giving up.
    if (res.status === 401 && !retried) {
      this._token = null;
      return this._fetchJson(url, true);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return res.json();
  }

  _url(path, params = {}) {
    const u = path.startsWith("http")
      ? new URL(path)
      : new URL(path, apiHost(this.region));
    u.searchParams.set("namespace", this.namespace);
    u.searchParams.set("locale", this.locale);
    for (const [k, v] of Object.entries(params)) {
      u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  _cachePath(url) {
    if (!this.useCache) return null;
    // Key strips the (constant alias) namespace param; build-pinning comes from
    // this.cacheDir (set once the build is resolved), not the key.
    const key = url.replace(/([?&])namespace=[^&]*/, "");
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);
    return join(this.cacheDir, `${hash}.json`);
  }

  /**
   * The exact client build the API is currently serving, in wago.tools form
   * (e.g. "12.0.7.67808"). Read from the version-pinned namespace Blizzard echoes
   * back in any response href (`static-12.0.7_67808-us`). Pins both the API cache
   * dir and the DB2 pull to the same build the tree data came from. The index is
   * fetched fresh (not cached) so a patch is detected even with a warm cache.
   */
  async resolvedBuild() {
    if (this._build) return this._build;
    const idx = await this._fetchJson(this._url("/data/wow/talent-tree/index"));
    this._build = buildFromNamespaceHref(idx?._links?.self?.href, this.region);
    if (this.useCache && this._build) {
      this.cacheDir = join(CACHE_DIR, this._build);
      pruneSiblingDirs(CACHE_DIR, this._build);
      mkdirSync(this.cacheDir, { recursive: true });
    }
    return this._build;
  }
}

/**
 * Extract the wago.tools build (e.g. "12.0.7.67808") from a version-pinned
 * namespace href like ".../?namespace=static-12.0.7_67808-us". Pure.
 */
export function buildFromNamespaceHref(href, region) {
  const m = (href ?? "").match(new RegExp(`static-(.+?)-${region}\\b`));
  return m ? m[1].replace("_", ".") : null;
}

/** Convenience: a spell's icon NAME (basename, no extension) via the Media API. */
export async function fetchIconName(api, spellId) {
  const media = await api.get(`/data/wow/media/spell/${spellId}`);
  const icon = (media.assets ?? []).find((a) => a.key === "icon");
  if (!icon) return null;
  const m = icon.value.match(/\/([^/]+)\.(?:jpg|png)$/i);
  return m ? m[1] : null;
}

/**
 * A spell's rendered tooltip description (raw HTML/text, NOT yet sanitised) via
 * the Spell API. Works for any spell id, including the apex capstone's extra-rank
 * spells that the talent-tree endpoint omits.
 */
export async function fetchSpellDescription(api, spellId) {
  const spell = await api.get(`/data/wow/spell/${spellId}`);
  return spell?.description ?? "";
}

/** True if the on-disk cache currently holds anything (diagnostics only). */
export function cachePopulated() {
  return existsSync(CACHE_DIR) && readdirSync(CACHE_DIR).length > 0;
}

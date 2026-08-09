/**
 * fetchIcons.js
 * -------------
 * Downloads every talent/spec/class icon referenced by src/data/ into
 * public/talent-icons/, so the app can serve icons first-party instead of
 * hotlinking a third-party CDN. Third-party icon requests are blocked by common
 * content blockers and browser tracking protection, which left users staring at
 * broken images; same-origin icons are never blocked.
 *
 * Like the talent-data ingest, this is a run-when-needed step whose output is
 * committed to the repo — it is NOT part of the build. Re-run it after a data
 * change that introduces new icons:
 *
 *   node scripts/fetchIcons.js
 *
 * It is incremental: icons already present in public/talent-icons/ are skipped, so a
 * re-run only fetches what's new. Delete public/talent-icons/ to force a full refetch.
 *
 * Icons are downloaded from Blizzard's own render CDN (first-party, and the exact
 * file names the Game Data Media API reports, so the names always match src/data
 * with no slug-translation map to maintain):
 *   https://render.worldofwarcraft.com/us/icons/56/<name>.jpg
 * We still self-host the result (this is a build-time download, not a runtime
 * hotlink) because third-party hotlinks were blocked by content blockers.
 *
 * Names with no real art (e.g. hero-subtree placeholders, which are rendered as
 * text) return 403/404; they're reported at the end and simply have no local file
 * — the app already falls back to a blank pixel for those.
 */

import { readFileSync, readdirSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { classIconSlug } from "../src/lib/iconUrl.js";
import { writeFileAtomic } from "./lib/blizzardApi.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "src", "data");
const OUT_DIR = join(__dirname, "..", "public", "talent-icons");
const BASE_URL = "https://render.worldofwarcraft.com/us/icons/56";
const CONCURRENCY = 16;
const MAX_ATTEMPTS = 3;
// Backoff before each retry (not after the final attempt): a transient 403 from
// CDN rate-limiting needs time to clear, and 16 workers retrying back-to-back
// only deepens the throttle. Exponential with a little jitter spreads the load.
const RETRY_BACKOFF_MS = [250, 500, 1000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Walk an arbitrary JSON value, collecting every non-empty `icon` string.
function collectIcons(value, sink) {
  if (Array.isArray(value)) {
    for (const item of value) collectIcons(item, sink);
  } else if (value && typeof value === "object") {
    if (typeof value.icon === "string" && value.icon) {
      sink.add(value.icon.toLowerCase());
    }
    for (const key of Object.keys(value)) collectIcons(value[key], sink);
  }
}

// Build the full set of icon slugs the app can request.
function gatherIconNames() {
  const icons = new Set();
  for (const file of readdirSync(DATA_DIR)) {
    if (!file.endsWith(".json")) continue;
    collectIcons(JSON.parse(readFileSync(join(DATA_DIR, file), "utf8")), icons);
  }
  // The class grid derives its icon via classIconSlug — the same shared
  // formula BuildManager renders with, so the downloaded set can't drift from
  // what the UI requests.
  const classes = JSON.parse(
    readFileSync(join(DATA_DIR, "classes.json"), "utf8"),
  );
  for (const cls of classes) {
    icons.add(classIconSlug(cls.name));
  }
  return [...icons].sort();
}

export async function fetchOne(name) {
  const dest = join(OUT_DIR, `${name}.jpg`);
  if (existsSync(dest)) return "skipped";
  let lastErr;
  let lastStatus = 0; // last HTTP status seen (0 = network/timeout error)
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // Wait before retrying so a rate-limited CDN has a chance to recover;
      // add jitter so the concurrent workers don't all retry in lockstep.
      const base = RETRY_BACKOFF_MS[attempt - 1] ?? RETRY_BACKOFF_MS.at(-1);
      await sleep(base + Math.floor(Math.random() * base * 0.25));
    }
    try {
      const res = await fetch(`${BASE_URL}/${name}.jpg`, {
        signal: AbortSignal.timeout(15000),
      });
      lastStatus = res.status;
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0) throw new Error("empty body");
        // Guard against a truncated response: a 200 whose connection drops
        // mid-body yields a short buffer. Once written, the incremental
        // `existsSync` skip never re-fetches it, so a corrupt icon would be
        // committed and shipped. Verify completeness before writing; a throw
        // here is caught below and retried, then surfaced as a failure.
        const declared = res.headers.get("content-length");
        const encoding = res.headers.get("content-encoding");
        // Only a real compression encoding (gzip/br/deflate) invalidates the
        // length check: fetch has already decompressed the body, so buf no
        // longer matches the compressed Content-Length. `identity` (or an empty
        // value) means the body was not transformed, so Content-Length is still
        // the exact size and the strong length check must apply — otherwise a
        // truncated `identity` response would fall through to the weaker marker
        // check and slip past if it happened to end in the JPEG EOI bytes.
        const encoded =
          encoding != null && encoding.trim().toLowerCase() !== "identity";
        if (declared != null && !encoded) {
          if (buf.length !== Number(declared)) {
            throw new Error(`truncated: ${buf.length} of ${declared} bytes`);
          }
        } else if (
          buf[buf.length - 2] !== 0xff ||
          buf[buf.length - 1] !== 0xd9
        ) {
          // No Content-Length to check against (e.g. a chunked response) — fall
          // back to the JPEG end-of-image marker as the completeness signal.
          throw new Error("truncated: missing JPEG end marker");
        }
        // A 200 can still carry a non-image (an error/placeholder page); the
        // JPEG start-of-image marker rejects that instead of saving it as .jpg.
        if (buf[0] !== 0xff || buf[1] !== 0xd8) {
          throw new Error("not a JPEG (bad start marker)");
        }
        // Atomic (tmp + rename): the length/marker checks above catch network
        // truncation, but a crash or disk-full mid-write would still leave a
        // torn file that the incremental existsSync skip then treats as
        // complete forever — the exact hazard writeFileAtomic exists for.
        writeFileAtomic(dest, buf);
        return "downloaded";
      }
      // A 404 is a slug with no real art. A 403 may be that too (the CDN
      // answers 403 for a denied key) or a rate-limit block — retry rather than
      // give up here, and see the classification below.
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastStatus = 0; // a thrown error isn't a clean HTTP status
      lastErr = err;
    }
  }
  // Only a stable 404 means "no real art" — that is the CDN's answer for a slug
  // it has no object for, and it is safe to exit 0 over.
  //
  // A stable 403 is NOT safe to treat the same way. It is what a throttling or
  // blocking CDN returns, and the whole retry budget here is a few hundred
  // milliseconds across CONCURRENCY workers — far below any real throttle
  // window, so a throttled run burns all three attempts almost instantly on
  // every icon in the window. Filing those under "no real art" and exiting 0
  // let a run report success while shipping talents that render as blank
  // fallbacks. Report it separately so the operator can re-run (the download is
  // incremental, so a re-run only retries what didn't land).
  if (lastStatus === 404) return "missing";
  if (lastStatus === 403) return "forbidden";
  throw lastErr ?? new Error("unknown fetch failure");
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const names = gatherIconNames();
  console.log(`${names.length} unique icons referenced.`);

  const stats = {
    downloaded: 0,
    skipped: 0,
    missing: [],
    forbidden: [],
    failed: [],
  };
  let cursor = 0;

  async function worker() {
    while (cursor < names.length) {
      const name = names[cursor++];
      try {
        const result = await fetchOne(name);
        if (result === "downloaded") stats.downloaded++;
        else if (result === "skipped") stats.skipped++;
        else if (result === "missing") stats.missing.push(name);
        else if (result === "forbidden") stats.forbidden.push(name);
      } catch (err) {
        stats.failed.push(`${name} (${err.message})`);
      }
      if (cursor % 200 === 0) console.log(`  …${cursor}/${names.length}`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(
    `\nDone: ${stats.downloaded} downloaded, ${stats.skipped} already present.`,
  );
  if (stats.missing.length) {
    console.log(
      `\n${stats.missing.length} icon(s) 404 (no real art — blank fallback):`,
    );
    for (const n of stats.missing) console.log(`  - ${n}`);
  }
  if (stats.forbidden.length) {
    console.log(
      `\n${stats.forbidden.length} icon(s) refused with HTTP 403 — most likely a rate limit,` +
        ` not missing art. Re-run to retry just these (the download is incremental):`,
    );
    for (const n of stats.forbidden) console.log(`  - ${n}`);
    process.exitCode = 1;
  }
  if (stats.failed.length) {
    console.log(`\n${stats.failed.length} icon(s) FAILED (network/other):`);
    for (const n of stats.failed) console.log(`  - ${n}`);
    process.exitCode = 1;
  }
}

// Run only when invoked directly, not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

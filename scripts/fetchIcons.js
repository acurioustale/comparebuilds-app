/**
 * fetchIcons.js
 * -------------
 * Downloads every talent/spec/class icon referenced by src/data/ into
 * public/talent-icons/, so the app can serve icons first-party instead of hotlinking
 * wow.zamimg.com. Third-party icon requests are blocked by common content
 * blockers and browser tracking protection (the icons live on a Fandom/ZAM
 * domain), which left users staring at broken images; same-origin icons are
 * never blocked.
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
 * Source/size mirror what the app requests: the "medium" (36x36) JPEGs at
 *   https://wow.zamimg.com/images/wow/icons/medium/<name>.jpg
 *
 * Icon names that 404 (e.g. hero-subtree placeholders that were never real
 * icon slugs) are reported at the end and simply have no local file — the app
 * already falls back to a blank pixel for those.
 */

import {
  readFileSync,
  readdirSync,
  mkdirSync,
  existsSync,
  writeFileSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "src", "data");
const OUT_DIR = join(__dirname, "..", "public", "talent-icons");
const BASE_URL = "https://wow.zamimg.com/images/wow/icons/medium";
const CONCURRENCY = 16;

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
  // The class grid derives its icon from the class slug (see BuildManager):
  // classicon_<slug with underscores removed>.
  const classes = JSON.parse(
    readFileSync(join(DATA_DIR, "classes.json"), "utf8"),
  );
  for (const cls of classes) {
    icons.add(("classicon_" + cls.name.replaceAll("_", "")).toLowerCase());
  }
  return [...icons].sort();
}

async function fetchOne(name) {
  const dest = join(OUT_DIR, `${name}.jpg`);
  if (existsSync(dest)) return "skipped";
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/${name}.jpg`, {
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 404) return "missing";
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error("empty body");
      writeFileSync(dest, buf);
      return "downloaded";
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const names = gatherIconNames();
  console.log(`${names.length} unique icons referenced.`);

  const stats = { downloaded: 0, skipped: 0, missing: [], failed: [] };
  let cursor = 0;

  async function worker() {
    while (cursor < names.length) {
      const name = names[cursor++];
      try {
        const result = await fetchOne(name);
        if (result === "downloaded") stats.downloaded++;
        else if (result === "skipped") stats.skipped++;
        else if (result === "missing") stats.missing.push(name);
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
  if (stats.failed.length) {
    console.log(`\n${stats.failed.length} icon(s) FAILED (network/other):`);
    for (const n of stats.failed) console.log(`  - ${n}`);
    process.exitCode = 1;
  }
}

main();

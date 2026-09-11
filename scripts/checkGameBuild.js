/**
 * checkGameBuild.js
 * -----------------
 * Answers one cheap question: has the game moved on since we last acknowledged
 * it? It reads the `wowBuild` each Raidbots channel reports in its metadata.json
 * (https://www.raidbots.com/developers) and compares live against the stamp in
 * scripts/gameBuild.json.
 *
 * Why this exists. The two real checks are expensive in different ways —
 * compareSources.js needs Blizzard credentials and re-derives every class, and
 * checkWireLayout.js pulls a ~3 MB file per channel. Neither is a thing to run
 * constantly, and neither answers "is there anything to look at today?". This
 * does, from a ~1 KB file and no credentials, so it can run daily and stay quiet
 * until it isn't.
 *
 * What it compares, and why not the whole build string. A build string is
 * `12.1.0.69587`: a patch version plus a build number. Talent trees change with
 * the PATCH; the build number moves for every hotfix, many times per patch. So
 * the default compares only the patch version — the low-noise, high-signal half
 * — and reports the build number as detail. `--exact` compares the whole string
 * for when you do want every build.
 *
 * The stamp is an ACKNOWLEDGEMENT, not a derived fact: nothing in src/data/
 * records the build it came from, and this script cannot discover it. It records
 * the build a human last confirmed the data against, so it means "we have looked
 * at this one" — which is exactly what makes a later difference actionable.
 * Update it with --accept AFTER re-ingesting (or after confirming a patch
 * changed nothing that matters), never as a way to silence the check.
 *
 * Run:
 *   node scripts/checkGameBuild.js            # compare live's patch version
 *   node scripts/checkGameBuild.js --exact    # compare the full build string
 *   node scripts/checkGameBuild.js --accept   # record the current live build
 *
 * Network-dependent, so like its siblings this is NOT part of the validate gate
 * — see .github/workflows/sources.yml.
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { fetchMetadata, splitBuild, ENVIRONMENTS } from "./lib/raidbots.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const STAMP_PATH = join(__dirname, "gameBuild.json");

export function parseArgs(argv) {
  const args = { exact: false, accept: false };
  for (const a of argv) {
    if (a === "--exact") args.exact = true;
    else if (a === "--accept") args.accept = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

/**
 * Compare a live build against the acknowledged stamp.
 *
 * @param {string} live    wowBuild reported by the live channel
 * @param {object} stamp   parsed gameBuild.json
 * @param {boolean} exact  compare the whole build string, not just the version
 * @returns {{changed: boolean, from: string, to: string, scope: string}}
 */
export function compareBuild(live, stamp, exact = false) {
  const scope = exact ? "build" : "patch version";
  const pick = (b) => (exact ? String(b ?? "") : splitBuild(b).version);
  const from = pick(stamp?.acknowledgedBuild);
  const to = pick(live);
  return { changed: from !== to, from, to, scope };
}

export function readStamp(path = STAMP_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Rewrite the stamp with the build being acknowledged. Preserves any keys it
 * doesn't own so a future field added by hand isn't silently dropped.
 */
export function writeStamp(
  build,
  { path = STAMP_PATH, now = new Date() } = {},
) {
  let existing = {};
  try {
    existing = readStamp(path);
  } catch {
    // A missing or unreadable stamp is fine here — --accept is exactly how the
    // first one gets created.
  }
  const next = {
    ...existing,
    acknowledgedBuild: build,
    acknowledgedAt: now.toISOString().slice(0, 10),
  };
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Read every channel: the comparison is against live, but showing where ptr
  // and beta sit is what makes a checkWireLayout warning on those channels
  // readable — it says whether the channel is ahead of live or merely stale.
  const builds = {};
  for (const env of ENVIRONMENTS) {
    try {
      const meta = await fetchMetadata({ env });
      builds[env] = { build: meta.wowBuild, generatedAt: meta.generatedAt };
    } catch (err) {
      // A channel that isn't published right now is normal (there is often no
      // PTR between patches) and must not fail a probe about live.
      builds[env] = { error: err.message };
    }
  }

  console.log("\n── Raidbots channel builds ──");
  for (const env of ENVIRONMENTS) {
    const b = builds[env];
    console.log(
      `  ${env.padEnd(5)} ${b.error ? `(unavailable: ${b.error})` : `${b.build}  generated ${b.generatedAt}`}`,
    );
  }

  const live = builds.live?.build;
  if (!live) {
    // live always exists; its absence is a real failure, not a quiet channel.
    console.error(
      "\n✗ could not read the live build — check the network/upstream.",
    );
    process.exit(1);
  }

  if (args.accept) {
    const next = writeStamp(live);
    console.log(
      `\n✓ acknowledged ${next.acknowledgedBuild} (${next.acknowledgedAt}) → ${STAMP_PATH}`,
    );
    process.exit(0);
  }

  const stamp = readStamp();
  const { changed, from, to, scope } = compareBuild(live, stamp, args.exact);
  if (!changed) {
    console.log(
      `\n✓ live is on the acknowledged ${scope} (${to}). Nothing to look at.`,
    );
    process.exit(0);
  }

  console.log(
    `\n⚠ live ${scope} moved ${from} → ${to} (acknowledged build ` +
      `${stamp.acknowledgedBuild}, live ${live}).\n` +
      `  Next: node scripts/checkWireLayout.js   — does the build-string layout still agree?\n` +
      `        node scripts/compareSources.js    — full drift check (needs Blizzard credentials)\n` +
      `  Then re-ingest if needed and record it: node scripts/checkGameBuild.js --accept`,
  );
  // Non-zero so a scheduled run is visibly actionable rather than a line nobody
  // reads. It is a prompt to look, not an assertion that anything is broken —
  // which is why the noisy build-number half is excluded by default.
  process.exit(1);
}

// Only run when invoked directly (not when imported by a test), mirroring the
// entry guard in compareSources.js.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

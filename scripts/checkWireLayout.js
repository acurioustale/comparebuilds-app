/**
 * checkWireLayout.js
 * ------------------
 * Confirms our build-string wire layout against Raidbots' independently-derived
 * node ordering (https://www.raidbots.com/developers → static data → talents.json).
 *
 * What it proves. Every node's bit position in a build string is decided by the
 * order of collectClassNodes() (see src/lib/buildString.js). That ordering is
 * derived from src/data/ by our own code, and the committed snapshot
 * (wireLayout.snapshot.json) only pins it against ITSELF: it catches an
 * accidental change, but it cannot catch our derivation being wrong in the same
 * way twice, nor tell us the GAME's ordering has moved. Raidbots publishes
 * `fullNodeOrder` per spec — the same list, derived by a different toolchain
 * (SimC's casc/dbc extraction) from the game client. Agreement between the two is
 * outside evidence that the layout every share link depends on is correct.
 *
 * How it differs from compareSources.js. That is the full drift check and the
 * source of record; this is narrow and credential-free, so it can run where
 * compareSources can't:
 *   - no Blizzard API secrets, so it works on fork PRs;
 *   - `--env=ptr` / `--env=beta` reads the NEXT patch's node set, turning a
 *     wire-layout break into advance warning instead of a post-patch incident.
 *
 * Failure semantics differ by channel, deliberately:
 *   - live  — a mismatch means committed data and the shipped game disagree
 *             RIGHT NOW: every existing build string and share link for that
 *             class parses wrong. Exits non-zero.
 *   - ptr/beta — a mismatch is EXPECTED whenever a patch is in test; it is
 *             notice that a re-ingest is due before that patch goes live. Always
 *             exits zero, so a routine PTR build never reads as a broken repo.
 *
 * Run:
 *   node scripts/checkWireLayout.js                  # live, all classes
 *   node scripts/checkWireLayout.js --env=ptr        # next patch, warn-only
 *   node scripts/checkWireLayout.js --class=warrior
 *   node scripts/checkWireLayout.js --no-cache       # bypass the disk cache
 *
 * Network-dependent, so like compareSources.js this is NOT part of the validate
 * gate — see .github/workflows/sources.yml.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { collectClassNodes } from "../src/lib/buildString.js";
import { fetchTalents, assertEnvironment } from "./lib/raidbots.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "src", "data");

export function parseArgs(argv) {
  const args = { classSlug: null, env: "live", cache: true };
  for (const a of argv) {
    if (a === "--no-cache") args.cache = false;
    else if (a.startsWith("--env=")) {
      args.env = assertEnvironment(a.slice("--env=".length));
    } else if (a.startsWith("--class=")) {
      args.classSlug = a.slice("--class=".length);
      // An empty value is falsy and would slip past the caller's filter guard,
      // silently checking EVERY class — `--class=$UNSET_VAR` must not quietly
      // mean "no filter". Mirrors compareSources.js / ingestBlizzard.js.
      if (!args.classSlug)
        throw new Error("--class= requires a class slug (got an empty value)");
    } else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

/**
 * Collapse Raidbots' per-SPEC talents.json entries into one node order per class.
 *
 * `fullNodeOrder` is a class-wide list, so every spec of a class must carry an
 * identical copy. If two specs disagree we cannot say which one the game means,
 * and comparing against an arbitrary one would be a coin flip — so record the
 * conflict and let the caller report it rather than pick.
 *
 * @param {object[]} talents Parsed talents.json (one entry per spec)
 * @returns {Map<number, {className: string, order: number[], conflict: boolean}>}
 *          keyed by Blizzard classId (a stable numeric key — Raidbots spells the
 *          names out, "Death Knight" vs our death_knight slug)
 */
export function nodeOrderByClassId(talents) {
  const byClass = new Map();
  for (const entry of talents) {
    const order = (entry.fullNodeOrder ?? []).map(Number);
    const seen = byClass.get(entry.classId);
    if (!seen) {
      byClass.set(entry.classId, {
        className: entry.className,
        order,
        conflict: false,
      });
      continue;
    }
    if (!seen.conflict && seen.order.join() !== order.join())
      seen.conflict = true;
  }
  return byClass;
}

/**
 * Diff our derived node order against theirs.
 *
 * Order is the whole point — the list index IS the bit position — so this is a
 * positional comparison, not a set comparison. The set difference is reported
 * alongside only to explain the mismatch: node ids on one side alone mean a
 * patch added or removed talents, whereas identical sets with a mismatched index
 * mean the same nodes got REORDERED, which is the more insidious case (no node
 * appears or disappears, every build string just silently shifts).
 *
 * @returns {{match: boolean, ourCount: number, theirCount: number,
 *            firstMismatchIndex: number, onlyOurs: number[], onlyTheirs: number[]}}
 */
export function diffNodeOrder(ours, theirs) {
  const firstMismatchIndex = (() => {
    const n = Math.min(ours.length, theirs.length);
    for (let i = 0; i < n; i++) if (ours[i] !== theirs[i]) return i;
    return ours.length === theirs.length ? -1 : n;
  })();
  const theirSet = new Set(theirs);
  const ourSet = new Set(ours);
  return {
    match: firstMismatchIndex === -1,
    ourCount: ours.length,
    theirCount: theirs.length,
    firstMismatchIndex,
    onlyOurs: ours.filter((id) => !theirSet.has(id)),
    onlyTheirs: theirs.filter((id) => !ourSet.has(id)),
  };
}

/** Human-readable one-line explanation of a diffNodeOrder result. */
export function describeDiff(d) {
  if (d.match) return `${d.ourCount} nodes in identical order`;
  const parts = [`ours=${d.ourCount} theirs=${d.theirCount}`];
  if (d.onlyOurs.length)
    parts.push(
      `${d.onlyOurs.length} node(s) only in ours (${preview(d.onlyOurs)})`,
    );
  if (d.onlyTheirs.length)
    parts.push(
      `${d.onlyTheirs.length} node(s) only in theirs (${preview(d.onlyTheirs)})`,
    );
  if (!d.onlyOurs.length && !d.onlyTheirs.length)
    parts.push("same node set, REORDERED");
  parts.push(`first mismatch at index ${d.firstMismatchIndex}`);
  return parts.join("; ");
}

const preview = (ids) =>
  ids.length <= 5 ? ids.join(", ") : `${ids.slice(0, 5).join(", ")}, …`;

/**
 * Compare every implemented class. Pure apart from reading src/data/ — the
 * fetched talents are passed in, so a test can drive it without the network.
 *
 * @returns {{rows: Array<{slug, ok, note}>, mismatches: number}}
 */
export function compareAll({ classIndex, talents, readClass }) {
  const byClass = nodeOrderByClassId(talents);
  const rows = [];
  let mismatches = 0;
  for (const cls of classIndex) {
    const theirs = byClass.get(cls.id);
    if (!theirs) {
      // Absence is not agreement. Skipping silently would let the whole check
      // pass while comparing nothing — the same trap the --class= guard closes.
      rows.push({
        slug: cls.name,
        ok: false,
        note: "absent from talents.json",
      });
      mismatches++;
      continue;
    }
    if (theirs.conflict) {
      rows.push({
        slug: cls.name,
        ok: false,
        note: "specs disagree on fullNodeOrder upstream — cannot compare",
      });
      mismatches++;
      continue;
    }
    const ours = collectClassNodes(readClass(cls.name)).map((n) => n.id);
    const d = diffNodeOrder(ours, theirs.order);
    if (!d.match) mismatches++;
    rows.push({ slug: cls.name, ok: d.match, note: describeDiff(d) });
  }
  return { rows, mismatches };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const classIndex = JSON.parse(
    readFileSync(join(DATA_DIR, "classes.json"), "utf8"),
  ).filter((c) => c.implemented);

  let implemented = classIndex;
  if (args.classSlug) {
    implemented = implemented.filter((c) => c.name === args.classSlug);
    // A typo'd slug would otherwise filter to zero classes and report a green
    // "0 mismatch(es)" having compared nothing.
    if (implemented.length === 0)
      throw new Error(`no implemented class named "${args.classSlug}"`);
  }

  let talents;
  try {
    talents = await fetchTalents({ env: args.env, cache: args.cache });
  } catch (err) {
    // Between patches there is often no PTR or beta build published at all, and
    // the file simply 404s. That is the absence of a test realm, not a failure
    // of this check — treat it as nothing to compare rather than letting a
    // scheduled run go red every quiet week. A missing `live` file IS a real
    // failure (it always exists), so only the warn-only channels get this pass.
    if (args.env !== "live" && /HTTP 404/.test(err.message)) {
      console.log(
        `\n⚠ no ${args.env} data published right now (404) — nothing to compare.`,
      );
      process.exit(0);
    }
    throw err;
  }

  console.log(`\n── Wire layout vs Raidbots talents.json (${args.env}) ──`);
  const { rows, mismatches } = compareAll({
    classIndex: implemented,
    talents,
    readClass: (slug) =>
      JSON.parse(readFileSync(join(DATA_DIR, `${slug}.json`), "utf8")),
  });
  for (const r of rows)
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.slug.padEnd(14)} ${r.note}`);

  // Only `live` is a statement about the game as shipped; a PTR/beta divergence
  // is the check doing its job early, not a broken repo.
  const fatal = args.env === "live";
  if (mismatches === 0) {
    console.log(`\n✓ all ${rows.length} class(es) agree with Raidbots.`);
  } else if (fatal) {
    console.log(
      `\n✗ ${mismatches} class(es) disagree with Raidbots on live. Every existing ` +
        `build string and share link for those classes parses differently than ` +
        `the game intends — re-ingest (scripts/ingestBlizzard.js) and investigate.`,
    );
  } else {
    console.log(
      `\n⚠ ${mismatches} class(es) differ on ${args.env}. Expected while a patch is ` +
        `in test: it means a re-ingest is due before that patch goes live.`,
    );
  }
  process.exit(mismatches === 0 || !fatal ? 0 : 1);
}

// Only run when invoked directly (not when imported by a test), mirroring the
// entry guard in compareSources.js.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

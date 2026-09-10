/**
 * fetchTopBuilds.js
 * -----------------
 * Regenerates src/data/topBuilds.json from Raidbots' daily "top sims" summary
 * (https://www.raidbots.com/developers → Data Analysis).
 *
 * What the data is, precisely — the wording matters, because it is easy to
 * oversell. Raidbots publishes the highest sims it saw in the last 30 days: the
 * top 100 actors per spec, from Quick Sims and the best actors of Top Gear sims.
 * The `talents` column is a raw Blizzard loadout string, the same thing a player
 * pastes into this app, so it decodes with our own parser and needs no
 * translation layer. But most rows come from Raidbots' OPTIMIZER rather than a
 * player's own choices, so this is "what sims well", not "what the community
 * plays" — and it is DPS-sim data, so healers and tanks are thin or absent. The
 * UI must not claim more than that.
 *
 * Every string is decoded against our committed class data before it is written.
 * A row that our parser can't load is dropped rather than shipped: the file is
 * consumed by the app itself, and a build string that fails to parse there would
 * surface as a broken slot the user can do nothing about. A high drop rate means
 * something real moved (a patch shifted the node set, or the format changed), so
 * the run fails rather than quietly shipping a thinned file.
 *
 * Run:
 *   node scripts/fetchTopBuilds.js            # report only, writes nothing
 *   node scripts/fetchTopBuilds.js --write    # regenerate src/data/topBuilds.json
 *   node scripts/fetchTopBuilds.js --per-spec=3
 *
 * Build-time only, network-dependent; never part of the validate gate. The
 * generated file IS committed, so the app never talks to Raidbots at runtime —
 * the same rule the class data follows.
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { collectClassNodes, parseBuildString } from "../src/lib/buildString.js";
import { parseCsv } from "./lib/blizzardDb2.js";
import { fetchTopSummaryCsv, TOP_SUMMARY_URL } from "./lib/raidbots.js";
import {
  aggregateBySpec,
  assertColumns,
  assertHomogeneous,
} from "./lib/topBuildsCore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "src", "data");
export const OUT_PATH = join(DATA_DIR, "topBuilds.json");

// Keep at most this many builds per spec. The app compares at most MAX_BUILDS
// (5) at once, so more than that could never be loaded together anyway.
const DEFAULT_PER_SPEC = 5;

// Above this share of undecodable rows, stop and fail. A handful of odd rows is
// normal (a hand-edited profile, a string from a newer build); a large fraction
// means the node set moved under us and the whole file would be wrong.
const MAX_DROP_RATIO = 0.1;

export function parseArgs(argv) {
  const args = { write: false, perSpec: DEFAULT_PER_SPEC };
  for (const a of argv) {
    if (a === "--write") args.write = true;
    else if (a.startsWith("--per-spec=")) {
      const n = Number(a.slice("--per-spec=".length));
      if (!Number.isInteger(n) || n < 1)
        throw new Error("--per-spec= requires a positive integer");
      args.perSpec = n;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

/**
 * Decode and validate each CSV row against our committed class data.
 *
 * @param {object[]} rows        parsed summary.csv rows
 * @param {object[]} classIndex  classes.json
 * @param {(slug: string) => object} readClass
 * @returns {{kept: object[], dropped: Array<{class: string, spec: string, reason: string}>}}
 */
export function validateRows(rows, classIndex, readClass) {
  // Class slugs in the CSV are spelled out ("death knight"); ours are
  // underscored. Build the map from the committed index so a renamed class is
  // picked up automatically rather than from a hand-kept lookup table.
  const bySlug = new Map(classIndex.map((c) => [c.name, c]));
  const nodeCache = new Map();
  const nodesFor = (slug) => {
    if (!nodeCache.has(slug))
      nodeCache.set(slug, collectClassNodes(readClass(slug)));
    return nodeCache.get(slug);
  };

  const kept = [];
  const dropped = [];
  for (const row of rows) {
    const slug = String(row.class ?? "").replace(/ /g, "_");
    const cls = bySlug.get(slug);
    const drop = (reason) =>
      dropped.push({ class: row.class, spec: row.spec, reason });

    if (!cls || !cls.implemented) {
      drop(`no implemented local data for class "${row.class}"`);
      continue;
    }
    let parsed;
    try {
      parsed = parseBuildString(row.talents, nodesFor(slug));
    } catch (err) {
      drop(`talents string did not decode: ${err.message}`);
      continue;
    }
    // The header's spec id must be a spec we actually know, or the app could
    // never route the string to a tree.
    if (!cls.specs.some((s) => s.id === parsed.specId)) {
      drop(`decoded spec id ${parsed.specId} is not in the local index`);
      continue;
    }
    kept.push({
      specId: parsed.specId,
      talents: row.talents,
      dps: Number(row.dps) || 0,
      itemLevel: Number(row.itemLevel) || 0,
      fightStyle: row.fightStyle,
      enemyCount: row.enemyCount,
    });
  }
  return { kept, dropped };
}

/** Assemble the committed file from validated rows. */
export function buildFile({ rows, perSpec, generatedAt }) {
  const shape = assertHomogeneous(rows);
  return {
    _comment:
      "Generated by scripts/fetchTopBuilds.js from Raidbots' public top-sims " +
      "summary. These are the most frequent talent strings among the highest " +
      "sims of the last 30 days — mostly optimizer output, so 'what sims well', " +
      "not 'what the community plays'. Do not hand-edit; re-run the script.",
    source: TOP_SUMMARY_URL,
    generatedAt,
    fightStyle: shape.fightStyle,
    enemyCount: shape.enemyCount,
    specs: aggregateBySpec(rows, perSpec),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const classIndex = JSON.parse(
    readFileSync(join(DATA_DIR, "classes.json"), "utf8"),
  );

  const csv = await fetchTopSummaryCsv();
  const rows = parseCsv(csv);
  assertColumns(rows);

  const { kept, dropped } = validateRows(rows, classIndex, (slug) =>
    JSON.parse(readFileSync(join(DATA_DIR, `${slug}.json`), "utf8")),
  );

  console.log(`\n── Raidbots top sims ──`);
  console.log(`  ${rows.length} row(s) fetched, ${kept.length} decoded`);
  if (dropped.length) {
    // Group the reasons: a hundred identical lines say no more than one does.
    const byReason = new Map();
    for (const d of dropped)
      byReason.set(d.reason, (byReason.get(d.reason) ?? 0) + 1);
    for (const [reason, n] of byReason)
      console.log(`  dropped ${n}: ${reason}`);
  }

  const dropRatio = dropped.length / rows.length;
  if (dropRatio > MAX_DROP_RATIO) {
    console.error(
      `\n✗ ${(dropRatio * 100).toFixed(1)}% of rows failed to decode (limit ` +
        `${MAX_DROP_RATIO * 100}%). The node set has probably moved — run ` +
        `scripts/checkWireLayout.js and re-ingest before regenerating.`,
    );
    process.exit(1);
  }

  const file = buildFile({
    rows: kept,
    perSpec: args.perSpec,
    generatedAt: new Date().toISOString().slice(0, 10),
  });
  const specCount = Object.keys(file.specs).length;
  const entryCount = Object.values(file.specs).reduce(
    (n, e) => n + e.length,
    0,
  );
  console.log(
    `  ${specCount} spec(s), ${entryCount} entr(ies) at ≤${args.perSpec} per spec ` +
      `(${file.fightStyle}, ${file.enemyCount} target)`,
  );

  if (!args.write) {
    console.log(`\n✓ dry run — pass --write to update ${OUT_PATH}`);
    return;
  }
  writeFileSync(OUT_PATH, JSON.stringify(file, null, 2) + "\n", "utf8");
  console.log(`\n✓ wrote ${OUT_PATH}`);
}

// Only run when invoked directly (not when imported by a test), mirroring the
// entry guard in compareSources.js.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

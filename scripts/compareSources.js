/**
 * compareSources.js
 * -----------------
 * Re-derives the talent data from Blizzard live (Game Data API + client DB2) and
 * diffs it against the committed src/data/. This is the drift / freshness check:
 * it catches when the committed data has gone stale against a new game patch, or
 * when a hand-edit slipped something past the schema. Needs API credentials (see
 * .env.example).
 *
 * (Blizzard is the sole source now; the name is kept for the workflow + history.)
 *
 * It normalises Blizzard in memory and diffs it node-by-node against src/data/,
 * separating:
 *   - HARD divergences — build-string / correctness fields that MUST agree: the
 *     per-class wire-layout fingerprint, and for nodes present in both: maxRanks,
 *     choice arity, gate threshold (spentRequired), prerequisite connections
 *     (restricted to shared nodes), and the fields that drive the interactive
 *     calculator's validity — auto-grant status, tree section, and hero subtree;
 *     plus per spec the hero gate node id. Any of these failing exits non-zero.
 *   - SOFT divergences — fields that don't affect build strings: per-spec
 *     membership, positions, names, descriptions, budgets, checkpoints. Reported,
 *     never fail the run.
 *
 * Run:
 *   node scripts/compareSources.js                  # all classes
 *   node scripts/compareSources.js --class=warrior  # one class
 *   node scripts/compareSources.js --descriptions   # also diff description text (soft)
 *
 * Network-dependent (fetches Blizzard live), so this is intentionally NOT part of
 * the validate gate — see .github/workflows/sources.yml.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { wireLayout } from "../src/lib/wireLayout.js";
import { loadClassIndex, buildBlizzardClasses } from "./ingestBlizzard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "src", "data");

function parseArgs(argv) {
  const args = { classSlug: null, descriptions: false };
  for (const a of argv) {
    if (a === "--descriptions") args.descriptions = true;
    else if (a.startsWith("--class="))
      args.classSlug = a.slice("--class=".length);
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

// Compare as a set: order and duplicates are insignificant for connections.
const sortedIds = (arr) =>
  [...new Set((arr ?? []).map(Number))].sort((a, b) => a - b);

/**
 * Diff an apex capstone's DB2-sourced rank chain (committed cn vs fresh fn).
 * The summed-maxRanks check elsewhere can't catch a re-split (same total), a
 * changed rank SpellID, or a shifted unlock level — diff the chain itself.
 * Returns a list of hard-divergence messages (empty when the chains agree).
 * A present-vs-absent chain on either side is itself a divergence.
 */
function diffApexChain(cn, fn) {
  const msgs = [];
  const cRanks = cn.ranks ?? [];
  const fRanks = fn.ranks ?? [];
  if (cRanks.length !== fRanks.length) {
    msgs.push(`apex rank count ${cRanks.length}→${fRanks.length}`);
  } else {
    cRanks.forEach((cr, i) => {
      const fr = fRanks[i];
      if (cr.spellId !== fr.spellId)
        msgs.push(`apex rank[${i}] spellId ${cr.spellId}→${fr.spellId}`);
      if (cr.maxRanks !== fr.maxRanks)
        msgs.push(`apex rank[${i}] maxRanks ${cr.maxRanks}→${fr.maxRanks}`);
    });
  }
  const cLevels = cn.levels ?? [];
  const fLevels = fn.levels ?? [];
  if (cLevels.length !== fLevels.length) {
    msgs.push(`apex level count ${cLevels.length}→${fLevels.length}`);
  } else {
    cLevels.forEach((cl, i) => {
      if (cl !== fLevels[i]) msgs.push(`apex level[${i}] ${cl}→${fLevels[i]}`);
    });
  }
  return msgs;
}

/**
 * Diff a choice node's option list (committed cn vs fresh fn). The arity check
 * alone can't catch a re-pointed option (same count, a different spell at the
 * same index) or a changed per-option maxRanks — both are wire-relevant, since
 * the build string encodes the chosen option's positional index and its partial
 * rank. Option ORDER therefore matters and the diff is positional; option
 * name/icon/description stay soft (compared as node-level name/desc elsewhere).
 * Returns a list of hard-divergence messages (empty when the options agree).
 */
function diffChoices(cn, fn) {
  const msgs = [];
  const cCh = cn.choices ?? [];
  const fCh = fn.choices ?? [];
  if (cCh.length !== fCh.length) {
    msgs.push(`choice arity ${cCh.length}→${fCh.length}`);
    return msgs;
  }
  cCh.forEach((cc, i) => {
    const fc = fCh[i];
    if (cc.spellId !== fc.spellId)
      msgs.push(`choice[${i}] spellId ${cc.spellId}→${fc.spellId}`);
    if ((cc.maxRanks ?? 1) !== (fc.maxRanks ?? 1))
      msgs.push(`choice[${i}] maxRanks ${cc.maxRanks}→${fc.maxRanks}`);
  });
  return msgs;
}

/** Diff one class's freshly-ingested data against its committed data. */
export function diffClass(slug, fresh, committed, opts) {
  const hard = [];
  const soft = [];

  // Wire-layout fingerprint — the build-string compatibility gate.
  const freshWire = wireLayout(fresh);
  const committedWire = wireLayout(committed);
  if (freshWire.hash !== committedWire.hash) {
    hard.push(
      `wire layout differs (count ${committedWire.count}→${freshWire.count}, hash ${committedWire.hash}→${freshWire.hash})`,
    );
  }

  for (const specSlug of Object.keys(committed.specs)) {
    const cSpec = committed.specs[specSlug];
    const fSpec = fresh.specs[specSlug];
    const at = (kind, msg) =>
      (kind === "hard" ? hard : soft).push(`${specSlug}: ${msg}`);
    if (!fSpec) {
      hard.push(`${specSlug}: missing from fresh ingest`);
      continue;
    }

    if (fSpec.heroGateNodeId !== cSpec.heroGateNodeId)
      at(
        "hard",
        `heroGateNodeId ${cSpec.heroGateNodeId}→${fSpec.heroGateNodeId}`,
      );

    const cNodes = new Map(cSpec.nodes.map((n) => [n.id, n]));
    const fNodes = new Map(fSpec.nodes.map((n) => [n.id, n]));

    // Per-spec MEMBERSHIP can differ without breaking build strings — the wire
    // layout (a class-wide set) is unchanged, the node just displays under a
    // different spec, or is treated as an unused placeholder. The hash check above
    // is the build-string gate; membership is informational.
    const onlyCommitted = [...cNodes.keys()].filter((id) => !fNodes.has(id));
    const onlyFresh = [...fNodes.keys()].filter((id) => !cNodes.has(id));
    if (onlyCommitted.length || onlyFresh.length)
      at(
        "soft",
        `membership: ${onlyCommitted.length} committed-only, ${onlyFresh.length} fresh-only`,
      );

    let pos = 0,
      name = 0,
      desc = 0;
    for (const [id, cn] of cNodes) {
      const fn = fNodes.get(id);
      if (!fn) continue; // membership-only, reported above
      if (cn.maxRanks !== fn.maxRanks)
        at("hard", `node ${id} maxRanks ${cn.maxRanks}→${fn.maxRanks}`);
      // Choice nodes: diff the option list positionally, not just its length —
      // a re-pointed option or a changed per-option maxRanks is wire-relevant
      // even when the arity is unchanged (mirrors the apex chain diff below).
      if (cn.choices || fn.choices)
        for (const msg of diffChoices(cn, fn)) at("hard", `node ${id} ${msg}`);
      if (cn.spentRequired !== fn.spentRequired)
        at("hard", `node ${id} gate ${cn.spentRequired}→${fn.spentRequired}`);
      // Auto-grant, tree section, and hero subtree don't shift build-string bit
      // positions, so the wire-layout hash above misses them — but they drive the
      // interactive calculator's point budgets, gate cascade, and hero-subtree
      // exclusivity, so a drift here silently mis-computes validity with no other
      // signal. Hard, like the gate/prereq checks. Normalise undefined vs
      // false/null so a class node (no heroSubtree key) never false-positives.
      if ((cn.alreadyGranted ?? false) !== (fn.alreadyGranted ?? false))
        at(
          "hard",
          `node ${id} alreadyGranted ${cn.alreadyGranted}→${fn.alreadyGranted}`,
        );
      if (cn.treeType !== fn.treeType)
        at("hard", `node ${id} treeType ${cn.treeType}→${fn.treeType}`);
      if ((cn.heroSubtree ?? null) !== (fn.heroSubtree ?? null))
        at(
          "hard",
          `node ${id} heroSubtree ${cn.heroSubtree}→${fn.heroSubtree}`,
        );
      // Compare only edges to nodes present in BOTH specs, so a membership
      // difference doesn't masquerade as miswiring — a genuine prerequisite
      // change between shared nodes still trips here.
      const common = (conns) =>
        sortedIds(conns).filter((c) => cNodes.has(c) && fNodes.has(c));
      if (common(cn.connections).join() !== common(fn.connections).join())
        at("hard", `node ${id} connections differ`);
      // Apex capstone rank chain (DB2-sourced) — a re-split with the same total,
      // a changed rank SpellID, or a shifted unlock level all slip past the
      // summed maxRanks check above, so diff the chain itself.
      if (cn.type === "apex" || fn.type === "apex")
        for (const msg of diffApexChain(cn, fn))
          at("hard", `node ${id} ${msg}`);
      if (cn.posX !== fn.posX || cn.posY !== fn.posY) pos++;
      if (cn.name !== fn.name) name++;
      if (opts.descriptions && cn.description !== fn.description) desc++;
    }
    if (pos) at("soft", `${pos} node position(s) differ`);
    if (name) at("soft", `${name} node name(s) differ`);
    if (desc) at("soft", `${desc} node description(s) differ`);

    // Checkpoints (visual gate ladder) — soft.
    if (JSON.stringify(cSpec.checkpoints) !== JSON.stringify(fSpec.checkpoints))
      at("soft", "checkpoints differ");
    if (JSON.stringify(cSpec.pointBudget) !== JSON.stringify(fSpec.pointBudget))
      at("soft", "pointBudget differs");
  }

  // A spec present only in the fresh ingest — one a game patch added — is never
  // reached by the committed-keyed loop above (its removal counterpart is the
  // `!fSpec` branch inside it). Report it hard: its heroGate, gates and wiring
  // are unvalidated, and while the class-wide wire-hash flags the node-id change
  // it doesn't say which spec drifted.
  for (const specSlug of Object.keys(fresh.specs))
    if (!committed.specs[specSlug])
      hard.push(`${specSlug}: new spec in fresh ingest (not in committed)`);

  return { hard, soft };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const classIndex = loadClassIndex();
  let implemented = classIndex.filter((c) => c.implemented);
  if (args.classSlug)
    implemented = implemented.filter((c) => c.name === args.classSlug);

  const fresh = await buildBlizzardClasses({
    implemented,
    descriptions: args.descriptions,
    icons: false, // compare never diffs icons; skip the per-spell media fetch
  });

  console.log("\n── Fresh Blizzard ingest vs committed ──");
  let hardTotal = 0;
  let softTotal = 0;
  for (const cls of implemented) {
    const f = fresh[cls.name];
    if (!f) {
      console.log(`  ✗ ${cls.name}: not produced by the ingest`);
      hardTotal++;
      continue;
    }
    const committed = JSON.parse(
      readFileSync(join(DATA_DIR, `${cls.name}.json`), "utf8"),
    );
    const { hard, soft } = diffClass(cls.name, f, committed, args);
    hardTotal += hard.length;
    softTotal += soft.length;

    const tag = hard.length === 0 ? "✓" : "✗";
    console.log(
      `  ${tag} ${cls.name.padEnd(14)} ${hard.length} hard, ${soft.length} soft`,
    );
    for (const h of hard) console.log(`      HARD  ${h}`);
    for (const s of soft) console.log(`      soft  ${s}`);
  }

  console.log(
    `\n${hardTotal === 0 ? "✓" : "✗"} ${hardTotal} hard divergence(s), ${softTotal} soft (informational).`,
  );
  process.exit(hardTotal === 0 ? 0 : 1);
}

// Only run when invoked directly (not when imported by a test), mirroring the
// entry guard in generateLayoutManifest.js.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

/**
 * ingestBlizzard.js
 * -----------------
 * Third talent-data source — and the authoritative one. Maps Blizzard's official
 * World of Warcraft Game Data API (the upstream Icy Veins and Wowhead both copy
 * from) to the same normalised schema as the other ingests (src/data/{slug}.json),
 * via the shared, source-agnostic pipeline (scripts/lib/ingestCore.js).
 *
 * Why this source: it issues the canonical Blizzard trait-node IDs that the whole
 * build-string wire format is built on, so it is the truest oracle for the
 * wire-layout snapshot — stronger than either scraper, which merely re-publish
 * these same IDs.
 *
 * Roles (see CLAUDE.md "Data is the contract"):
 *   - Runs in VERIFY mode by default: fetch + normalise + schema-validate +
 *     fingerprint against the committed snapshot, writing NOTHING.
 *   - `--promote` makes Blizzard the writer (writes src/data/). `--update-snapshot`
 *     additionally regenerates the snapshot — only do that deliberately (it
 *     redefines the build-string oracle).
 *
 * Wire-layout placeholders: the build-string serialisation space contains two
 * kinds of node that aren't talents — the hero-subtree gate (a CHOICE node) and
 * reserved/unused slots. The API exposes both as spell-less nodes (a first rank
 * with neither a tooltip nor choice_of_tooltips); we lift the CHOICE one into the
 * spec's heroGateNodeId and the rest into class-level unusedNodeIds, exactly the
 * ids collectClassNodes() re-injects into the layout (see isEmptyNode).
 *
 * Apex capstones: the one node shape the web API can't supply. It flattens these
 * sequential multi-spell capstones to a single rank, so their true rank chain
 * (spells, ranks, unlock levels) is read from the client DB2 tables instead (see
 * scripts/lib/blizzardDb2.js); the extra ranks' descriptions come from the web
 * API's per-spell endpoint. This is the only place the data isn't from the tree
 * endpoint — and it needs no scraper or committed-data fallback.
 *
 * Run:
 *   node scripts/ingestBlizzard.js                  # verify all classes, write nothing
 *   node scripts/ingestBlizzard.js --class=hunter   # verify a single class (spike)
 *   node scripts/ingestBlizzard.js --no-descriptions # skip tooltip text (soft field)
 *   node scripts/ingestBlizzard.js --no-icons       # skip per-spell media lookups
 *   node scripts/ingestBlizzard.js --promote        # write src/data/ from Blizzard
 *
 * Credentials: see .env.example and scripts/lib/blizzardApi.js. Build-time only;
 * never deployed.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { sanitizeDescription } from "../src/lib/sanitizeDescription.js";
import { cellKey } from "../src/lib/treeLogic.js";
import {
  POINT_BUDGET,
  writeNormalizedData,
  verifyAgainstSnapshot,
  validateClasses,
} from "./lib/ingestCore.js";
import {
  BlizzardApi,
  fetchIconName,
  fetchSpellDescription,
} from "./lib/blizzardApi.js";
import { BlizzardDb2 } from "./lib/blizzardDb2.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "src", "data");

// Blizzard node_type.type → our schema's node type. There is no "apex" type here;
// the spec capstones are detected and rebuilt from DB2 (see buildApexNode).
const TYPE_MAP = { PASSIVE: "round", ACTIVE: "square", CHOICE: "choice" };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = {
    promote: false,
    updateSnapshot: false,
    descriptions: null, // follows --promote (soft field; skipped on verify)
    icons: null, //        follows --promote (soft field; skipped on verify)
    classSlug: null,
    noCache: false,
  };
  for (const a of argv) {
    if (a === "--promote" || a === "--write") args.promote = true;
    else if (a === "--update-snapshot") args.updateSnapshot = true;
    else if (a === "--descriptions") args.descriptions = true;
    else if (a === "--no-descriptions") args.descriptions = false;
    else if (a === "--icons") args.icons = true;
    else if (a === "--no-icons") args.icons = false;
    else if (a === "--no-cache") args.noCache = true;
    else if (a.startsWith("--class="))
      args.classSlug = a.slice("--class=".length);
    else throw new Error(`unknown argument: ${a}`);
  }
  // The snapshot is only rewritten on the promote path (writeNormalizedData).
  // Passing --update-snapshot without --promote takes the verify branch and
  // writes nothing, so the operator's requested snapshot bump silently never
  // lands — fail loudly instead.
  if (args.updateSnapshot && !args.promote)
    throw new Error(
      "--update-snapshot requires --promote (the snapshot is only rewritten while promoting)",
    );
  if (args.descriptions === null) args.descriptions = args.promote;
  if (args.icons === null) args.icons = args.promote;
  return args;
}

// ---------------------------------------------------------------------------
// Index → spec→tree map
// ---------------------------------------------------------------------------

export function loadClassIndex() {
  return JSON.parse(readFileSync(join(DATA_DIR, "classes.json"), "utf8"));
}

/**
 * Map every specialization id to its talent-tree id by parsing the talent-tree
 * index. Each spec href looks like
 *   .../talent-tree/{treeId}/playable-specialization/{specId}
 */
async function fetchSpecTreeMap(api) {
  const index = await api.get("/data/wow/talent-tree/index");
  const map = new Map();
  for (const t of index.spec_talent_trees ?? []) {
    const m = t.key.href.match(
      /talent-tree\/(\d+)\/playable-specialization\/(\d+)/,
    );
    if (m) map.set(Number(m[2]), Number(m[1]));
  }
  return map;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const rankTooltip = (rank) => rank?.tooltip ?? null;
const isGranted = (node) =>
  (node.ranks ?? []).some((r) => (r.default_points ?? 0) > 0);

// A node with no spell association at all (its first rank carries neither a
// tooltip nor a choice_of_tooltips) is not a real talent. It lives in the
// build-string serialisation space but is one of two kinds of placeholder:
//   - a CHOICE-typed one is the hero-subtree gate node (the 2-bit left/right
//     pick) → recorded as the spec's heroGateNodeId, and
//   - any other is a reserved/unused slot → recorded in class-level unusedNodeIds.
// Both are kept OUT of the nodes array; collectClassNodes() re-injects them into
// the wire layout from heroGateNodeId / unusedNodeIds. This is how the API
// natively supplies the two ids we feared it withheld.
const isEmptyNode = (n) => {
  const r = n.ranks?.[0];
  return !r?.tooltip && !(r?.choice_of_tooltips?.length > 0);
};

/**
 * The wire-identity fields every normalised node shares — ordinary, choice, and
 * the DB2-sourced apex alike: id, type, position, prereqs, gate, granted flag.
 * Kept in one place so the apex builder and normaliseNode can't derive a hard
 * wire field (e.g. posX spacing, spentRequired) two different ways.
 * @param {object} raw          a *_talent_node from the API
 * @param {'round'|'square'|'choice'|'apex'} type
 * @param {'class'|'spec'|'hero'} treeType
 * @param {(nodeId:number)=>number} gateOf  node id → points-spent gate
 */
function wireBase(raw, type, treeType, gateOf) {
  return {
    id: raw.id,
    type,
    treeType,
    // Positions are SOFT (not in the wire-layout fingerprint). display_col is a
    // step-1 grid, but the renderer spaces columns by one CELL (36px) and a choice
    // node is wider than that — so double X to the step-2 spacing the renderer
    // expects (matching the other sources). posY is fine at step 1; the absolute
    // origin is normalised per panel by the layout code.
    posX: raw.display_col * 2,
    posY: raw.display_row,
    connections: raw.locked_by ?? [],
    // The points-spent gate (the gate cascade reads this per node; see treeLogic).
    spentRequired: gateOf(raw.id),
    alreadyGranted: isGranted(raw),
  };
}

/**
 * Normalise one Blizzard talent node into our schema.
 * @param {object} raw          a *_talent_node from the API
 * @param {'class'|'spec'|'hero'} treeType
 * @param {string|null} heroSubtree
 * @param {(spellId:number)=>Promise<string|null>} iconOf  spellId → icon name
 * @param {(spellId:number,desc:string)=>string} descOf    tooltip → sanitised HTML
 * @param {(nodeId:number)=>number} gateOf  node id → points-spent gate
 */
async function normaliseNode(
  raw,
  treeType,
  heroSubtree,
  iconOf,
  descOf,
  spellDescOf,
  clientDescOf,
  gateOf,
) {
  const type = TYPE_MAP[raw.node_type?.type] ?? "round";
  const isChoice = type === "choice";

  const base = wireBase(raw, type, treeType, gateOf);
  if (heroSubtree != null) base.heroSubtree = heroSubtree;

  // The tree endpoint sometimes ships a node/option with no inline tooltip text
  // (e.g. monk Conduit's "Restore Balance"), so fall back: first the spell's own
  // description from the Spell API, then — for the spec-conditional ones the API
  // also leaves blank — the rendered client DB2 template (clientDescOf).
  const descFor = async (spellId, inlineHtml) => {
    const inline = descOf(spellId, inlineHtml ?? "");
    if (inline || spellId == null) return inline;
    return (await spellDescOf(spellId)) || (await clientDescOf(spellId));
  };

  if (isChoice) {
    // choice_of_tooltips sits directly on the rank, not under `tooltip`.
    const opts = raw.ranks?.[0]?.choice_of_tooltips ?? [];
    const choices = [];
    for (const tt of opts) {
      const spellId = tt.spell_tooltip?.spell?.id;
      choices.push({
        spellId,
        // Fall back to the node id, not a bare `String(spellId)` — a choice
        // option with no talent name, no spell name, and no spell id would
        // otherwise ship the literal string "undefined" (which passes the
        // non-empty-string validator). Mirrors the non-choice path below.
        name:
          tt.talent?.name ??
          tt.spell_tooltip?.spell?.name ??
          String(spellId ?? raw.id),
        icon: (await iconOf(spellId)) ?? String(spellId ?? raw.id),
        description: await descFor(spellId, tt.spell_tooltip?.description),
        maxRanks: 1,
      });
    }
    return {
      ...base,
      maxRanks: 1,
      name: null,
      icon: null,
      description: null,
      choices,
    };
  }

  // Apex capstones never reach here — they're detected from DB2 and built by
  // buildApexNode before normaliseNode is called (see emit() in normaliseSpec).
  const tt = rankTooltip(raw.ranks?.[0]);
  const spellId = tt?.spell_tooltip?.spell?.id;
  return {
    ...base,
    maxRanks: raw.ranks?.length ?? 1,
    name: tt?.talent?.name ?? tt?.spell_tooltip?.spell?.name ?? String(raw.id),
    icon: (await iconOf(spellId)) ?? String(spellId ?? raw.id),
    description: await descFor(spellId, tt?.spell_tooltip?.description),
    choices: null,
  };
}

/**
 * Derive the visual gate ladder from the nodes themselves: for each section, each
 * distinct non-zero spentRequired becomes one checkpoint placed at the first
 * (lowest posY) node carrying that gate. Sourcing it from real (posY,
 * spentRequired) pairs keeps it consistent with the per-node gates by
 * construction (see dataIntegrity's gate-checkpoint test).
 */
export function checkpointsFromNodes(nodes) {
  const section = (treeType) => {
    const firstRow = new Map(); // points → min posY
    for (const n of nodes) {
      if (n.treeType !== treeType || !(n.spentRequired > 0)) continue;
      const cur = firstRow.get(n.spentRequired);
      if (cur == null || n.posY < cur) firstRow.set(n.spentRequired, n.posY);
    }
    return [...firstRow.entries()]
      .map(([points, row]) => ({ row, points }))
      .sort((a, b) => a.points - b.points);
  };
  return { class: section("class"), spec: section("spec") };
}

/** Hero subtree root: a node with no in-tree prerequisite. */
function heroRootId(nodes) {
  const root = nodes.find((n) => !(n.locked_by ?? []).length);
  return root ? root.id : (nodes[0]?.id ?? null);
}

/**
 * Build an apex node from the Blizzard node's wire identity (id, position,
 * prereqs) plus the rank chain read from the client DB2 tables (see blizzardDb2),
 * which the web API flattens away. The node's display name/icon come from the web
 * API's rank-1 tooltip; each rank's description from the per-spell endpoint.
 * Connections are filtered to in-spec ids later.
 */
async function buildApexNode(raw, chain, iconOf, spellDescOf, gateOf) {
  const tt = rankTooltip(raw.ranks?.[0]);
  const headSpell = tt?.spell_tooltip?.spell?.id ?? chain.ranks[0]?.spellId;
  const ranks = [];
  for (const r of chain.ranks) {
    ranks.push({
      spellId: r.spellId,
      description: await spellDescOf(r.spellId),
      maxRanks: r.maxRanks,
    });
  }
  return {
    ...wireBase(raw, "apex", "spec", gateOf),
    maxRanks: chain.ranks.reduce((s, r) => s + r.maxRanks, 0),
    name: tt?.talent?.name ?? tt?.spell_tooltip?.spell?.name ?? String(raw.id),
    icon: (await iconOf(headSpell)) ?? String(headSpell ?? raw.id),
    description: null,
    levels: chain.levels,
    ranks,
  };
}

/**
 * Normalise one spec's tree into our spec object.
 * @param {object} specInfo   classes.json spec entry
 * @param {object} tree       the playable-specialization talent-tree response
 * @param {object} db2        loaded BlizzardDb2, for apex rank chains
 * @param {object} fns        { iconOf, descOf, spellDescOf }
 * @returns {object} the normalised spec
 */
export function extractHeroSubtrees(tree, specInfoId) {
  const heroTrees = (tree.hero_talent_trees ?? []).filter((ht) =>
    (ht.playable_specializations ?? []).some((s) => s.id === specInfoId),
  );
  // Left/right by subtree id ascending — this matches the in-game panel order
  const [left, right] = [...heroTrees].sort((a, b) => a.id - b.id);
  const heroIds = new Set(
    heroTrees.flatMap((ht) => (ht.hero_talent_nodes ?? []).map((n) => n.id)),
  );
  return { heroTrees, left, right, heroIds };
}

export function filterSpecVariants(built, specInfoId, db2) {
  // Spec-variant filter: some trees are shared by several specs and place, at one
  // grid cell, a separate variant of a talent per spec.
  const cellHasNativeVariant = new Set();
  for (const n of built)
    if (db2.appliesToSpec(n.id, specInfoId))
      cellHasNativeVariant.add(cellKey(n));
  const nodes = built.filter(
    (n) =>
      db2.appliesToSpec(n.id, specInfoId) ||
      !cellHasNativeVariant.has(cellKey(n)),
  );

  // A hero-subtree root has no prerequisites at all; the game auto-grants it
  // when the gate selects that subtree. Identify roots by their ORIGINAL
  // (pre-filter) connections — a non-root hero node whose only prereq is a node
  // the spec-variant filter drops below would otherwise fall to zero connections
  // and be mistaken for a root and wrongly granted.
  const heroRootIds = new Set(
    nodes
      .filter(
        (n) => n.treeType === "hero" && (n.connections ?? []).length === 0,
      )
      .map((n) => n.id),
  );

  // Drop connections to nodes not present in this spec
  const includedIds = new Set(nodes.map((n) => n.id));
  for (const n of nodes)
    n.connections = (n.connections ?? []).filter((id) => includedIds.has(id));

  // Auto-grant the hero-subtree roots (see above)
  for (const n of nodes) if (heroRootIds.has(n.id)) n.alreadyGranted = true;

  return nodes;
}

export function calculatePointBudgets(nodes, left, right, baseBudget) {
  // Hero budget = spendable (non-granted) talents in a subtree, counted by grid position.
  const heroCellCount = (sub) =>
    sub
      ? new Set(
          nodes
            .filter((n) => n.heroSubtree === sub.name && !n.alreadyGranted)
            .map((n) => `${n.posX},${n.posY}`),
        ).size
      : 0;
  const heroNodeCount = Math.max(heroCellCount(left), heroCellCount(right));
  const apex = nodes.find((n) => n.type === "apex");

  return {
    ...baseBudget,
    spec: baseBudget.spec + (apex ? apex.maxRanks : 0),
    hero: heroNodeCount,
  };
}

export async function normaliseSpec(specInfo, tree, db2, fns) {
  const { iconOf, descOf, spellDescOf, renderClientDesc } = fns;
  // Final description fallback, spec-bound: render the client DB2 tooltip
  // template for the spec-conditional spells the web API returns blank.
  const clientDescOf = (spellId) => renderClientDesc(spellId, specInfo.id);

  const { left, right, heroIds } = extractHeroSubtrees(tree, specInfo.id);

  // Lift the placeholder (spell-less) nodes out so they don't become talents.
  // The CHOICE one is this spec's hero gate (recorded here); the rest are reserved
  // slots, collected at class level from the base tree (see normaliseClass), since
  // the per-spec endpoint omits some of them. (see isEmptyNode).
  let heroGateNodeId = null;
  const classAndSpec = [
    ...(tree.class_talent_nodes ?? []),
    ...(tree.spec_talent_nodes ?? []),
  ];
  for (const n of classAndSpec) {
    if (isEmptyNode(n) && n.node_type?.type === "CHOICE") heroGateNodeId = n.id;
  }
  const placeholderIds = new Set(
    classAndSpec.filter(isEmptyNode).map((n) => n.id),
  );

  // Per-node points gate, from DB2's authoritative group conditions (NOT inferred
  // from the visual row — a node can sit below a divider yet unlock earlier).
  const gateOf = (nodeId) => db2.spentRequired(nodeId);

  // A node can appear in more than one of {class, spec, hero} arrays. Source hero
  // nodes ONLY from the hero trees (so they carry treeType "hero" + heroSubtree),
  // skip placeholders everywhere, and guard against any remaining cross-array
  // overlap with a seen-set (a node is emitted once). Apex capstones (detected
  // from DB2) get their flattened rank chain rebuilt.
  const seen = new Set();
  const built = [];
  const emit = async (n, treeType, sub) => {
    if (placeholderIds.has(n.id) || heroIds.has(n.id) || seen.has(n.id)) return;
    seen.add(n.id);
    const apexChain = db2.apexChain(n.id);
    built.push(
      apexChain
        ? await buildApexNode(n, apexChain, iconOf, spellDescOf, gateOf)
        : await normaliseNode(
            n,
            treeType,
            sub,
            iconOf,
            descOf,
            spellDescOf,
            clientDescOf,
            gateOf,
          ),
    );
  };

  for (const n of tree.class_talent_nodes ?? []) await emit(n, "class", null);
  for (const n of tree.spec_talent_nodes ?? []) await emit(n, "spec", null);
  for (const ht of [left, right].filter(Boolean)) {
    for (const n of ht.hero_talent_nodes ?? []) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      built.push(
        await normaliseNode(
          n,
          "hero",
          ht.name,
          iconOf,
          descOf,
          spellDescOf,
          clientDescOf,
          gateOf,
        ),
      );
    }
  }

  const nodes = filterSpecVariants(built, specInfo.id, db2);
  const pointBudget = calculatePointBudgets(nodes, left, right, POINT_BUDGET);

  // icon stays the subtree name (the renderer shows subtree headers as text, not
  // an icon file); description comes from DB2's TraitSubTree.
  const subtreeMeta = (ht) =>
    ht
      ? {
          name: ht.name,
          icon: ht.name,
          description: sanitizeDescription(
            db2.subtree(ht.id)?.description ?? "",
          ),
          rootNodeId: heroRootId(ht.hero_talent_nodes ?? []),
        }
      : { name: "Unknown", icon: "Unknown", description: "", rootNodeId: null };

  return {
    specId: specInfo.id,
    specName: specInfo.displayName,
    specSlug: specInfo.name,
    color: specInfo.color,
    icon: specInfo.icon,
    description: specInfo.description,
    pointBudget,
    checkpoints: checkpointsFromNodes(nodes),
    heroGateNodeId,
    heroSubtrees: { left: subtreeMeta(left), right: subtreeMeta(right) },
    nodes,
  };
}

/**
 * Collapse co-located duplicate nodes within a built spec.
 *
 * A single talent slot can be backed by more than one node id at one grid cell:
 * druid Starfire (91044/91046, same spell) and Moonkin Form (82208/91047, the
 * base-form spell vs a talent variant), paladin Lightforged Blessing
 * (103850/103852/103853). A grid cell IS one slot — so however many of its ids a
 * serialised build sets, it is one talent worth one point; counting or encoding
 * several over-budgets the section.
 *
 * The game's own loadout export keeps a single id per cell, and it is always the
 * lowest — confirmed against in-game re-exports for both a same-spell cell
 * (Starfire → 91044) and a different-spell one (Moonkin → 82208). So group the
 * non-granted nodes in a cell by talent NAME and, for any same-name group with
 * more than one id, keep the lowest and drop the rest (pruning connections to
 * them). Name — not spell — is the unifying key, because Moonkin's two ids are
 * one slot yet carry different spells; the cell already proves they are one slot,
 * and the same-name check guards against ever merging two genuinely different
 * talents that Blizzard might someday place at one cell (today none exist; a real
 * either/or pick is modelled as a CHOICE node, a single id).
 *
 * Mutates spec.nodes; returns the dropped ids so the caller can hold their wire
 * positions in class-level unusedNodeIds — their build-string bit positions must
 * not move.
 *
 * @param {object} spec  a normalised spec ({ nodes, ... })
 * @returns {number[]} dropped duplicate node ids
 */
export function collapseColocatedDuplicates(spec) {
  // cell → (talent name → node ids)
  const byCell = new Map();
  for (const n of spec.nodes) {
    if (n.alreadyGranted) continue;
    const byName = byCell.get(cellKey(n)) ?? new Map();
    byName.set(n.name, [...(byName.get(n.name) ?? []), n.id]);
    byCell.set(cellKey(n), byName);
  }

  const dropIds = new Set();
  for (const byName of byCell.values())
    for (const ids of byName.values()) {
      if (ids.length < 2) continue;
      ids.sort((a, b) => a - b);
      for (const id of ids.slice(1)) dropIds.add(id);
    }
  if (dropIds.size === 0) return [];

  spec.nodes = spec.nodes.filter((n) => !dropIds.has(n.id));
  for (const n of spec.nodes)
    n.connections = (n.connections ?? []).filter((id) => !dropIds.has(id));
  return [...dropIds];
}

/**
 * Filters a set of ids dropped as co-located duplicates down to those that are a
 * real node in NO spec, so only genuinely-unused ids are promoted into a class's
 * unusedNodeIds. An id dropped from one spec but still present in another is a
 * live node there and must be excluded — otherwise it would land in both
 * unusedNodeIds and a spec's real node list, which validateClassData rejects.
 *
 * @param {Iterable<number>} droppedIds ids removed by collapseColocatedDuplicates
 * @param {Record<string, {nodes: {id:number}[]}>} specs normalised specs (post-collapse)
 * @returns {number[]} the subset of droppedIds that is a real node in no spec
 */
export function idsUnusedAcrossSpecs(droppedIds, specs) {
  const realNodeIds = new Set();
  for (const spec of Object.values(specs))
    for (const n of spec.nodes) realNodeIds.add(n.id);
  return [...droppedIds].filter((id) => !realNodeIds.has(id));
}

async function normaliseClass(cls, treeMap, api, db2, fns) {
  const specs = {};
  for (const specInfo of cls.specs) {
    if (!treeMap.get(specInfo.id)) {
      console.warn(
        `  no talent-tree id for ${cls.displayName}/${specInfo.name}`,
      );
      continue;
    }
    const tree = await api.get(
      `/data/wow/talent-tree/${treeMap.get(specInfo.id)}/playable-specialization/${specInfo.id}`,
    );
    specs[specInfo.name] = await normaliseSpec(specInfo, tree, db2, fns);
  }

  // Reserved/unused placeholder ids: spell-less, non-CHOICE nodes in the base
  // tree's full node list (the gates are the CHOICE ones, captured per-spec).
  // The base endpoint is the complete set — some of these never appear in any
  // per-spec response (e.g. DH node 90912). Use the first spec that actually
  // mapped to a tree id: taking specs[0] unconditionally would fetch
  // talent-tree/undefined and crash the whole class if that one spec happens to
  // be unmapped while its siblings resolve.
  const treeId = cls.specs.map((s) => treeMap.get(s.id)).find(Boolean);
  let unusedNodeIds = [];
  if (treeId) {
    const base = await api.get(`/data/wow/talent-tree/${treeId}`);
    unusedNodeIds = (base.talent_nodes ?? [])
      .filter((n) => isEmptyNode(n) && n.node_type?.type !== "CHOICE")
      .map((n) => n.id)
      .sort((a, b) => a - b);
  }

  // Collapse same-talent co-located duplicates in each spec, and keep the dropped
  // ids in the class-wide wire layout via unusedNodeIds so build-string bit
  // positions (and existing share links) don't move.
  const droppedDuplicates = new Set();
  for (const spec of Object.values(specs))
    for (const id of collapseColocatedDuplicates(spec))
      droppedDuplicates.add(id);
  // Specs collapse independently, so an id dropped from one spec can still be a
  // real node in another (filterSpecVariants may leave the pair in spec A but
  // keep only the higher id in spec B, where it has no partner to collapse
  // against). Such an id is NOT an unused placeholder — it is a live node
  // elsewhere — so it must not enter unusedNodeIds, or validateClassData's
  // serialisation-space disjointness check would reject it as both a real node
  // and an unused placeholder and abort the promote.
  const trulyUnused = idsUnusedAcrossSpecs(droppedDuplicates, specs);
  if (trulyUnused.length > 0) {
    unusedNodeIds = [...new Set([...unusedNodeIds, ...trulyUnused])].sort(
      (a, b) => a - b,
    );
  }

  return {
    classId: cls.id,
    className: cls.displayName,
    classSlug: cls.name,
    color: cls.color,
    icon: cls.icon,
    unusedNodeIds,
    specs,
  };
}

/**
 * Fetch from Blizzard and normalise the requested classes. Pure of any src/data
 * writes — returns the in-memory dataset (slug → normalised class data).
 */
export async function buildBlizzardClasses({
  implemented,
  descriptions = true,
  icons = true,
  cache = true,
  quiet = false,
}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const api = new BlizzardApi({ cache });

  // Resolve the build FIRST: it pins the API cache dir (so a patch doesn't serve
  // stale responses) and the DB2 pull to the same build.
  const build = await api.resolvedBuild();
  log(`Loading client DB2 trait tables (build ${build})…`);
  // DB2 supplies the apex rank chains the web API flattens (a HARD,
  // snapshot-relevant field), so it loads on every run — unlike icons/descriptions.
  const db2 = await new BlizzardDb2({ build, cache }).load();

  log("Resolving talent-tree index…");
  const treeMap = await fetchSpecTreeMap(api);

  // Icons + descriptions are SOFT (no effect on schema or the snapshot), so
  // verify runs skip them for speed. Icons cost one Media call per spell;
  // tree descriptions are inlined already (just sanitised); apex extra-rank
  // descriptions need a per-spell fetch.
  const iconCache = new Map();
  // spellIds whose icon-name fetch threw (transient) and never succeeded on a
  // later retry. Surfaced loudly after the run so the operator knows the
  // committed String(spellId) placeholder is a fetch failure, not a real "no
  // icon" — and that a re-run should fill it.
  const iconFailures = new Set();
  const iconOf = icons
    ? async (spellId) => {
        if (spellId == null) return null;
        if (iconCache.has(spellId)) return iconCache.get(spellId);
        let name;
        try {
          name = await fetchIconName(api, spellId);
        } catch {
          // Transient fetch failure — return null but DON'T memoize it. A
          // legitimate "no icon" result (fetchIconName returns null) is still
          // cached below; only a thrown error is left uncached so a later node
          // sharing this spellId, and the next run, can retry instead of
          // committing String(spellId) as the icon on --promote.
          iconFailures.add(spellId);
          return null;
        }
        iconCache.set(spellId, name);
        iconFailures.delete(spellId); // a retry succeeded — no longer a failure
        return name;
      }
    : async () => null;
  const descOf = descriptions
    ? (_id, html) => sanitizeDescription(html)
    : () => "";
  // spellIds whose description fetch threw (transient) and never succeeded.
  // Surfaced after the run like iconFailures so the committed empty string is
  // recognised as a fetch failure, not a real "no description" — without this,
  // a transient failure ships permanent blank text on --promote and a re-run
  // treats the empty string as already-correct data.
  const descFailures = new Set();
  const spellDescOf = descriptions
    ? async (spellId) => {
        if (spellId == null) return "";
        try {
          return sanitizeDescription(await fetchSpellDescription(api, spellId));
        } catch {
          descFailures.add(spellId);
          return "";
        }
      }
    : async () => "";
  // Spec-conditional client DB2 templates, rendered for one spec (the web API
  // returns these blank). Gated by the descriptions flag like the others so a
  // verify run never fans out into per-spell DB2 fetches; bound to a spec in
  // normaliseSpec.
  const renderClientDesc = descriptions
    ? async (spellId, specId) =>
        sanitizeDescription((await db2.descriptionFor(spellId, specId)) ?? "")
    : async () => "";

  if (!icons) log("Skipping icons (soft).");
  if (!descriptions) log("Skipping descriptions (soft).");

  const classes = {};
  for (const cls of implemented) {
    const fns = { iconOf, descOf, spellDescOf, renderClientDesc };
    classes[cls.name] = await normaliseClass(cls, treeMap, api, db2, fns);
    log(`  normalised ${cls.displayName}`);
  }

  if (iconFailures.size > 0) {
    // Don't fail the run (icons are soft), but make the placeholder writes loud
    // so they aren't mistaken for real "no icon" data on --promote.
    console.warn(
      `  ⚠  ${iconFailures.size} icon name(s) failed to fetch (transient) and ` +
        `were written as numeric placeholders: ${[...iconFailures].join(", ")}. ` +
        `Re-run to fill them.`,
    );
  }

  if (descFailures.size > 0) {
    // Descriptions are soft too, but a swallowed transient failure would commit
    // a permanent empty description that a re-run can't tell from real "no
    // description" data, so make it loud.
    console.warn(
      `  ⚠  ${descFailures.size} spell description(s) failed to fetch (transient) ` +
        `and were written as empty: ${[...descFailures].join(", ")}. ` +
        `Re-run to fill them.`,
    );
  }

  return classes;
}

// ---------------------------------------------------------------------------
// Main (CLI)
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const classIndex = loadClassIndex();
  let implemented = classIndex.filter((c) => c.implemented);
  if (args.classSlug) {
    implemented = implemented.filter((c) => c.name === args.classSlug);
    if (implemented.length === 0)
      throw new Error(`no implemented class named "${args.classSlug}"`);
  }

  const classes = await buildBlizzardClasses({
    implemented,
    descriptions: args.descriptions,
    icons: args.icons,
    cache: !args.noCache,
  });

  // Verify mode (default): schema-validate + fingerprint + snapshot diff.
  if (!args.promote) {
    console.log("\n── Verify (no files written) ──");

    const { totalProblems, byClass } = validateClasses(classIndex, classes);
    for (const [slug, problems] of Object.entries(byClass)) {
      if (problems.length) {
        console.log(`  ✗ schema  ${slug}: ${problems.length} problem(s)`);
        for (const p of problems) console.log(`        - ${p}`);
      }
    }

    const { allMatch, results } = verifyAgainstSnapshot(classes);
    for (const r of results) {
      const tag = r.match ? "✓ match" : "✗ DIVERGES";
      const detail = r.match
        ? `count ${r.got.count}`
        : `expected ${r.expected ? `${r.expected.count}/${r.expected.hash}` : "(none)"} got ${r.got.count}/${r.got.hash}`;
      console.log(`  ${tag}  ${r.slug.padEnd(14)} ${detail}`);
    }

    const ok = allMatch && totalProblems === 0;
    console.log(
      ok
        ? "\n✓ Schema valid and build-string-compatible with the committed snapshot."
        : `\n✗ ${totalProblems} schema problem(s); snapshot ${allMatch ? "matches" : "diverges"} — Blizzard mapping needs work.`,
    );
    process.exit(ok ? 0 : 1);
  }

  // Promote: Blizzard becomes the writer.
  console.log("\n── Promote (writing src/data/) ──");
  const { validationFailures } = writeNormalizedData({
    classIndex,
    classes,
    updateSnapshot: args.updateSnapshot,
  });
  if (validationFailures > 0) process.exit(1);
  console.log("\nDone.");
}

// Run only when invoked directly, not when imported (e.g. by compareSources.js).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

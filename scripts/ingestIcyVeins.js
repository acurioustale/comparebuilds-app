/**
 * ingestIcyVeins.js
 * -----------------
 * Fetches talent tree data from Icy Veins' CDN and writes normalised JSON
 * to src/data/ (one file per class + classes.json index).
 *
 * This is the Icy Veins ingest, and the primary, snapshot-owning source. The
 * script is named for its source so a sibling importer for a different source
 * (e.g. ingestWowhead.js) can live alongside it — each fetches its own format,
 * maps it to the same schema (enforced by src/lib/validateClassData.js), and
 * hands the result to the shared pipeline in scripts/lib/ingestCore.js, so
 * src/data/ stays the contract. This file owns only the Icy-Veins-specific
 * fetching and normalisation; validating, writing, and regenerating the
 * wire-layout snapshot live in the core.
 *
 * Run:
 *   node scripts/ingestIcyVeins.js
 *
 * To target a different Icy Veins source or version:
 *   1. Change BASE_URL to any host that serves the same JSON shape.
 *   2. Bump VERSION to match the ?v= query param the server expects.
 *   3. If the host requires auth, add headers to the fetchJson() call.
 *
 * Output:
 *   src/data/classes.json          — flat index of all classes + specs
 *   src/data/{class_slug}.json     — normalised tree per class (all specs)
 */

import { sanitizeDescription } from "../src/lib/sanitizeDescription.js";
import { POINT_BUDGET, writeNormalizedData } from "./lib/ingestCore.js";

const BASE_URL = "https://static.icy-veins.com/json/midnight-talent-calculator";
const VERSION = 46;

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchJson(path) {
  const url = `${BASE_URL}/${path}?v=${VERSION}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Normalises a single raw node (classNode or specNode) from the source JSON.
 *
 * For choice nodes: name/icon/description are null; choices[] carries each
 * option. For regular nodes: choices is null.
 *
 * @param {object} raw        - Node object from classNodes/specNodes/hero.nodes
 * @param {'class'|'spec'|'hero'} treeType
 * @param {string|null} heroSubtree - Name of the hero subtree ("Deathbringer", etc.)
 */
function normaliseNode(raw, treeType, heroSubtree = null) {
  const isChoice = raw.type === "choice";
  const spell = raw.spells[0];

  const node = {
    id: raw.id,
    type: raw.type, // 'round' | 'square' | 'choice'
    treeType, // 'class' | 'spec' | 'hero'
    posX: raw.column, // grid column (integers, scale in UI)
    posY: raw.row, // grid row
    connections: raw.previousNodeIds,
    spentRequired: raw.spentAmountRequired ?? 0,
    alreadyGranted: raw.alreadyMaxedOut ?? false,
    maxRanks: isChoice ? 1 : spell.maxRanks,
    name: isChoice ? null : spell.name,
    icon: isChoice ? null : spell.icon,
    // Descriptions are rendered as HTML (TalentTree.jsx); sanitise at ingest so
    // the committed data is the trust boundary regardless of source.
    description: isChoice ? null : sanitizeDescription(spell.description),
    choices: isChoice
      ? raw.spells.map((s) => ({
          spellId: s.spellId,
          name: s.name,
          icon: s.icon,
          description: sanitizeDescription(s.description),
          maxRanks: s.maxRanks,
        }))
      : null,
  };

  if (heroSubtree !== null) node.heroSubtree = heroSubtree;

  return node;
}

/**
 * Normalises the apex node. The apex has no grid position and no per-choice
 * name/icon (only the overall node name/icon), so we derive posX/posY from
 * the surrounding spec node grid and set type 'apex'.
 *
 * @param {object} raw         - apexNode object
 * @param {object[]} specNodes - raw spec node values (for position derivation)
 */
function normaliseApexNode(raw, specNodes) {
  const rows = specNodes.map((n) => n.row);
  const cols = specNodes.map((n) => n.column);
  const posY = Math.max(...rows) + 2;
  const posX = Math.round((Math.min(...cols) + Math.max(...cols)) / 2);

  return {
    id: raw.id,
    type: "apex",
    treeType: "spec",
    posX,
    posY,
    connections: [],
    spentRequired: raw.spentAmountRequired,
    alreadyGranted: false,
    // Total points to fully invest in the apex node (sum of all rank groups).
    maxRanks: raw.spells.reduce((s, sp) => s + sp.maxRanks, 0),
    name: raw.name,
    icon: raw.icon,
    description: null,
    // levels[i] = character level at which ranks[i] abilities unlock.
    // These are NOT player choices — they unlock automatically at level.
    levels: raw.levels,
    ranks: raw.spells.map((s) => ({
      spellId: s.spellId,
      description: sanitizeDescription(s.description),
      maxRanks: s.maxRanks,
    })),
  };
}

/**
 * Normalises one spec's full tree into a flat nodes array plus metadata.
 *
 * @param {object} specRaw   - The spec entry from classData.specs[specName]
 * @param {object} specInfo  - The spec entry from classes_basic_info.json
 */
function normaliseSpec(specRaw, specInfo) {
  const nodes = [];

  for (const raw of Object.values(specRaw.classNodes)) {
    nodes.push(normaliseNode(raw, "class"));
  }

  for (const raw of Object.values(specRaw.specNodes)) {
    nodes.push(normaliseNode(raw, "spec"));
  }

  // Apex node — placed below the spec grid
  const apexNode = normaliseApexNode(
    specRaw.apexNode,
    Object.values(specRaw.specNodes),
  );
  nodes.push(apexNode);

  // Hero nodes — two mutually exclusive subtrees
  for (const side of ["left", "right"]) {
    const subtree = specRaw.hero[side];
    for (const raw of Object.values(subtree.nodes)) {
      nodes.push(normaliseNode(raw, "hero", subtree.name));
    }
  }

  // Hero budget = spendable nodes per subtree (excludes the alreadyGranted root node)
  const heroBudget = Object.values(specRaw.hero.left.nodes).filter(
    (n) => !n.alreadyMaxedOut,
  ).length;

  return {
    specId: specRaw.id,
    specName: specInfo.displayName,
    specSlug: specInfo.name,
    color: specInfo.color,
    icon: specInfo.icon,
    // Plain-text blurb — NOT HTML-rendered, so deliberately not sanitised. If you
    // ever render this (or the heroSubtrees descriptions below), keep it as text;
    // see src/lib/sanitizeDescription.js "SCOPE".
    description: specInfo.description,
    // Budgets derived from tree structure rather than hardcoded
    pointBudget: {
      ...POINT_BUDGET,
      spec: POINT_BUDGET.spec + apexNode.maxRanks,
      hero: heroBudget,
    },
    checkpoints: {
      class: specRaw.classCheckpoints,
      spec: specRaw.specCheckpoints,
    },
    heroGateNodeId: specRaw.hero.metaNodeId,
    heroSubtrees: {
      left: {
        name: specRaw.hero.left.name,
        icon: specRaw.hero.left.icon,
        description: specRaw.hero.left.description,
        rootNodeId: specRaw.hero.left.rootNodeId,
      },
      right: {
        name: specRaw.hero.right.name,
        icon: specRaw.hero.right.icon,
        description: specRaw.hero.right.description,
        rootNodeId: specRaw.hero.right.rootNodeId,
      },
    },
    nodes,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("Fetching class index…");
  const classInfoList = await fetchJson("classes_basic_info.json");

  // classes.json — lightweight index, no tree data
  const classIndex = classInfoList.map((cls) => ({
    id: cls.id,
    name: cls.name,
    displayName: cls.displayName,
    icon: cls.icon,
    color: cls.color,
    implemented: cls.implemented ?? false,
    specs: cls.specializations.map((s) => ({
      id: s.id,
      name: s.name,
      displayName: s.displayName,
      icon: s.icon,
      color: s.color,
      description: s.description,
    })),
  }));

  // Normalise every implemented class into the shared schema, keyed by slug.
  const classes = {};
  for (const cls of classInfoList) {
    if (!cls.implemented) {
      console.log(`  skipping ${cls.displayName} (not implemented)`);
      continue;
    }

    process.stdout.write(`Fetching ${cls.displayName}… `);
    const classRaw = await fetchJson(`${cls.name}.json`);

    const specs = {};
    for (const specInfo of cls.specializations) {
      const specRaw = classRaw.specs[specInfo.name];
      if (!specRaw) {
        console.warn(
          `  WARNING: no tree data for ${cls.displayName} / ${specInfo.displayName}`,
        );
        continue;
      }
      specs[specInfo.name] = normaliseSpec(specRaw, specInfo);
    }

    classes[cls.name] = {
      classId: cls.id,
      className: cls.displayName,
      classSlug: cls.name,
      color: cls.color,
      icon: cls.icon,
      // Node IDs present in the serialisation space but with no talent data.
      // The Blizzard export iterates over ALL of these (plus every node across
      // every spec) in sorted order, so they must be included when parsing build
      // strings or the per-node bit positions will be wrong.
      unusedNodeIds: classRaw.unusedNodeIds ?? [],
      specs,
    };
    console.log("done");
  }

  // Icy Veins is the primary, snapshot-owning source: validate, write src/data/,
  // and regenerate the wire-layout snapshot. The shared core exits the ingest
  // loudly on validation failure without updating the snapshot.
  const { validationFailures } = writeNormalizedData({
    classIndex,
    classes,
    updateSnapshot: true,
  });
  if (validationFailures > 0) process.exit(1);

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

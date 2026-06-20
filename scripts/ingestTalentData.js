/**
 * ingestTalentData.js
 * -------------------
 * Fetches talent tree data from Icy Veins' CDN and writes normalised JSON
 * to src/data/ (one file per class + classes.json index).
 *
 * Run:
 *   node scripts/ingestTalentData.js
 *
 * To target a different source or version:
 *   1. Change BASE_URL to any host that serves the same JSON shape.
 *   2. Bump VERSION to match the ?v= query param the server expects.
 *   3. If the host requires auth, add headers to the fetchJson() call.
 *
 * Output:
 *   src/data/classes.json          — flat index of all classes + specs
 *   src/data/{class_slug}.json     — normalised tree per class (all specs)
 */

import { writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { validateClassData } from '../src/lib/validateClassData.js'
import { wireLayout } from '../src/lib/wireLayout.js'
import { sanitizeDescription } from '../src/lib/sanitizeDescription.js'

const BASE_URL = 'https://static.icy-veins.com/json/midnight-talent-calculator'
const VERSION = 46

// Base talent point budgets for the Midnight expansion (from the levelling system).
// Levels 10-70 alternate class/spec → 31 class + 30 spec.
// Levels 71+ cycle across all three trees; class reaches 34, spec base 30, last hero point at 89.
// spec and hero are overridden by normaliseSpec at runtime (spec adds apex ranks; hero counts
// non-alreadyGranted hero nodes per subtree). alreadyGranted nodes are bonus and not counted.
const POINT_BUDGET = { class: 34, spec: 30, hero: 0 }

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'src', 'data')
const SNAPSHOT_PATH = join(__dirname, '..', 'src', 'lib', 'wireLayout.snapshot.json')

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchJson(path) {
  const url = `${BASE_URL}/${path}?v=${VERSION}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.json()
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
  const isChoice = raw.type === 'choice'
  const spell = raw.spells[0]

  const node = {
    id: raw.id,
    type: raw.type,           // 'round' | 'square' | 'choice'
    treeType,                  // 'class' | 'spec' | 'hero'
    posX: raw.column,          // grid column (integers, scale in UI)
    posY: raw.row,             // grid row
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
  }

  if (heroSubtree !== null) node.heroSubtree = heroSubtree

  return node
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
  const rows = specNodes.map((n) => n.row)
  const cols = specNodes.map((n) => n.column)
  const posY = Math.max(...rows) + 2
  const posX = Math.round((Math.min(...cols) + Math.max(...cols)) / 2)

  return {
    id: raw.id,
    type: 'apex',
    treeType: 'spec',
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
  }
}

/**
 * Normalises one spec's full tree into a flat nodes array plus metadata.
 *
 * @param {object} specRaw   - The spec entry from classData.specs[specName]
 * @param {object} specInfo  - The spec entry from classes_basic_info.json
 */
function normaliseSpec(specRaw, specInfo) {
  const nodes = []

  for (const raw of Object.values(specRaw.classNodes)) {
    nodes.push(normaliseNode(raw, 'class'))
  }

  for (const raw of Object.values(specRaw.specNodes)) {
    nodes.push(normaliseNode(raw, 'spec'))
  }

  // Apex node — placed below the spec grid
  const apexNode = normaliseApexNode(specRaw.apexNode, Object.values(specRaw.specNodes))
  nodes.push(apexNode)

  // Hero nodes — two mutually exclusive subtrees
  for (const side of ['left', 'right']) {
    const subtree = specRaw.hero[side]
    for (const raw of Object.values(subtree.nodes)) {
      nodes.push(normaliseNode(raw, 'hero', subtree.name))
    }
  }

  // Hero budget = spendable nodes per subtree (excludes the alreadyGranted root node)
  const heroBudget = Object.values(specRaw.hero.left.nodes).filter((n) => !n.alreadyMaxedOut).length

  return {
    specId: specRaw.id,
    specName: specInfo.displayName,
    specSlug: specInfo.name,
    color: specInfo.color,
    icon: specInfo.icon,
    description: specInfo.description,
    // Budgets derived from tree structure rather than hardcoded
    pointBudget: { ...POINT_BUDGET, spec: POINT_BUDGET.spec + apexNode.maxRanks, hero: heroBudget },
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
  }
}

// ---------------------------------------------------------------------------
// File output
// ---------------------------------------------------------------------------

function writeJson(filename, data) {
  const dest = join(OUT_DIR, filename)
  writeFileSync(dest, JSON.stringify(data, null, 2), 'utf8')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })

  let validationFailures = 0
  const builtClasses = {}

  console.log('Fetching class index…')
  const classInfoList = await fetchJson('classes_basic_info.json')

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
  }))

  writeJson('classes.json', classIndex)
  console.log('  → src/data/classes.json')

  // Per-class files
  for (const cls of classInfoList) {
    if (!cls.implemented) {
      console.log(`  skipping ${cls.displayName} (not implemented)`)
      continue
    }

    process.stdout.write(`Fetching ${cls.displayName}… `)
    const classRaw = await fetchJson(`${cls.name}.json`)

    const specs = {}
    for (const specInfo of cls.specializations) {
      const specRaw = classRaw.specs[specInfo.name]
      if (!specRaw) {
        console.warn(`  WARNING: no tree data for ${cls.displayName} / ${specInfo.displayName}`)
        continue
      }
      specs[specInfo.name] = normaliseSpec(specRaw, specInfo)
    }

    const classData = {
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
    }

    // Validate before writing so a source/schema drift fails the ingest loudly
    // rather than shipping broken data the app can't read.
    const problems = validateClassData(classData, classIndex.find((c) => c.id === cls.id))
    if (problems.length > 0) {
      console.error(`✗ validation failed (${problems.length})`)
      for (const p of problems) console.error(`      - ${p}`)
      validationFailures += problems.length
    }

    writeJson(`${cls.name}.json`, classData)
    builtClasses[cls.name] = classData
    console.log(`→ src/data/${cls.name}.json`)
  }

  if (validationFailures > 0) {
    console.error(`\n✗ ${validationFailures} validation problem(s) — data written for inspection, ` +
      `but the wire-layout snapshot was NOT updated. Fix the source/normaliser and re-run.`)
    process.exit(1)
  }

  // Refresh the wire-layout snapshot so the integrity test reflects this ingest.
  // The diff makes any build-string-breaking change visible in review.
  const snapshot = {}
  for (const name of Object.keys(builtClasses)) snapshot[name] = wireLayout(builtClasses[name])
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')
  console.log('→ src/lib/wireLayout.snapshot.json')

  console.log('\nDone.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

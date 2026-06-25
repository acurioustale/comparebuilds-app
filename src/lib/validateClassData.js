/**
 * src/lib/validateClassData.js
 *
 * Structural validator for the normalised class data in src/data/{slug}.json.
 *
 * The app reads ONLY this normalised schema — it never touches the upstream data
 * source. That makes the schema the contract between "however the data was
 * produced" (the ingest script, a hand edit, or a different source entirely) and
 * "what the UI and the build-string parser assume". This validator enforces that
 * contract so a bad edit or a source swap fails loudly here instead of crashing
 * at render time or — worse — silently misparsing build strings.
 *
 * Pure data-in / errors-out: no I/O, no throwing (unless you call the assert
 * helper). Safe to import in both Node (tests, ingest) and the browser.
 *
 * Usage:
 *   import { validateClassData, assertValidClassData } from './validateClassData.js'
 *   const errors = validateClassData(classData, classIndexEntry)  // string[]
 *   assertValidClassData(classData, classIndexEntry)              // throws on first failure
 */

const NODE_TYPES  = new Set(['round', 'square', 'choice', 'apex'])
const TREE_TYPES  = new Set(['class', 'spec', 'hero'])

const isInt    = (v) => Number.isInteger(v)
const isNum    = (v) => typeof v === 'number' && Number.isFinite(v)
const isStr    = (v) => typeof v === 'string' && v.length > 0
const isBool   = (v) => typeof v === 'boolean'
const isArr    = (v) => Array.isArray(v)

/**
 * Validates a single normalised class-data object.
 *
 * @param {object} data            Parsed src/data/{slug}.json
 * @param {object} [indexEntry]    Matching entry from classes.json (optional —
 *                                 enables cross-checks of ids/slugs/spec set)
 * @returns {string[]}  Human-readable error messages (empty = valid)
 */
export function validateClassData(data, indexEntry = null) {
  const errors = []
  const err = (msg) => errors.push(msg)

  if (data == null || typeof data !== 'object') {
    return ['class data must be an object']
  }

  // ── Top-level fields ────────────────────────────────────────────────────────
  if (!isInt(data.classId))    err('classId must be an integer')
  if (!isStr(data.classSlug))  err('classSlug must be a non-empty string')
  if (!isStr(data.className))   err('className must be a non-empty string')

  if (data.unusedNodeIds != null) {
    if (!isArr(data.unusedNodeIds)) {
      err('unusedNodeIds must be an array when present')
    } else if (!data.unusedNodeIds.every(isInt)) {
      err('unusedNodeIds must contain only integers')
    }
  }

  if (data.specs == null || typeof data.specs !== 'object' || isArr(data.specs)) {
    err('specs must be an object keyed by spec slug')
    return errors
  }
  const specSlugs = Object.keys(data.specs)
  if (specSlugs.length === 0) err('specs must contain at least one spec')

  // ── Per-spec ────────────────────────────────────────────────────────────────
  for (const slug of specSlugs) {
    const spec = data.specs[slug]
    const at = (msg) => err(`spec "${slug}": ${msg}`)

    if (spec == null || typeof spec !== 'object') {
      at('must be an object')
      continue
    }

    if (!isInt(spec.specId)) at('specId must be an integer')
    if (spec.specSlug !== slug) at(`specSlug "${spec.specSlug}" does not match its key "${slug}"`)

    // pointBudget
    const pb = spec.pointBudget
    if (pb == null || typeof pb !== 'object') {
      at('pointBudget must be an object')
    } else {
      for (const k of ['class', 'spec', 'hero']) {
        if (!isInt(pb[k]) || pb[k] < 0) at(`pointBudget.${k} must be a non-negative integer`)
      }
    }

    // checkpoints
    const cp = spec.checkpoints
    if (cp == null || typeof cp !== 'object') {
      at('checkpoints must be an object')
    } else {
      for (const k of ['class', 'spec']) {
        if (!isArr(cp[k])) {
          at(`checkpoints.${k} must be an array`)
        } else {
          cp[k].forEach((c, i) => {
            if (!isInt(c?.row) || !isInt(c?.points)) {
              at(`checkpoints.${k}[${i}] must have integer { row, points }`)
            }
          })
        }
      }
    }

    if (spec.heroGateNodeId != null && !isInt(spec.heroGateNodeId)) {
      at('heroGateNodeId must be an integer or null')
    }

    // heroSubtrees
    const hs = spec.heroSubtrees
    const subtreeNames = new Set()
    if (hs == null || typeof hs !== 'object') {
      at('heroSubtrees must be an object')
    } else {
      for (const side of ['left', 'right']) {
        const sub = hs[side]
        if (sub == null || typeof sub !== 'object') {
          at(`heroSubtrees.${side} must be an object`)
        } else {
          if (!isStr(sub.name)) at(`heroSubtrees.${side}.name must be a non-empty string`)
          else subtreeNames.add(sub.name)
          if (!isStr(sub.icon)) at(`heroSubtrees.${side}.icon must be a non-empty string`)
        }
      }
    }

    // nodes
    if (!isArr(spec.nodes) || spec.nodes.length === 0) {
      at('nodes must be a non-empty array')
      continue
    }

    const seenIds = new Set()
    const nodeIds = new Set(spec.nodes.map((n) => n?.id).filter(isInt))
    const usedSubtreeNames = new Set()

    spec.nodes.forEach((n, i) => {
      const nAt = (msg) => at(`node[${i}]${isInt(n?.id) ? ` (id ${n.id})` : ''}: ${msg}`)

      if (n == null || typeof n !== 'object') { nAt('must be an object'); return }

      if (!isInt(n.id)) nAt('id must be an integer')
      else if (seenIds.has(n.id)) nAt('duplicate node id')
      else seenIds.add(n.id)

      if (!NODE_TYPES.has(n.type)) nAt(`type "${n.type}" not in {${[...NODE_TYPES]}}`)
      if (!TREE_TYPES.has(n.treeType)) nAt(`treeType "${n.treeType}" not in {${[...TREE_TYPES]}}`)
      if (!isNum(n.posX)) nAt('posX must be a finite number')
      if (!isNum(n.posY)) nAt('posY must be a finite number')
      if (!isArr(n.connections) || !n.connections.every(isInt)) nAt('connections must be an integer array')
      if (!isInt(n.spentRequired) || n.spentRequired < 0) nAt('spentRequired must be a non-negative integer')
      if (!isBool(n.alreadyGranted)) nAt('alreadyGranted must be a boolean')
      if (!isInt(n.maxRanks) || n.maxRanks < 1) nAt('maxRanks must be a positive integer')

      // Dangling connections are tolerated by the renderer (it filters them), but
      // they almost always signal a stale/incomplete edit — surface as an error.
      if (isArr(n.connections)) {
        for (const cid of n.connections) {
          if (isInt(cid) && !nodeIds.has(cid)) nAt(`connection ${cid} references a node not in this spec`)
        }
      }

      // Type-specific shape
      if (n.type === 'choice') {
        if (!isArr(n.choices) || n.choices.length < 2) {
          nAt('choice node must have a choices array of length >= 2')
        } else {
          n.choices.forEach((ch, ci) => {
            if (!isStr(ch?.name)) nAt(`choices[${ci}].name must be a non-empty string`)
            if (!isStr(ch?.icon)) nAt(`choices[${ci}].icon must be a non-empty string`)
            if (!isInt(ch?.maxRanks) || ch.maxRanks < 1) nAt(`choices[${ci}].maxRanks must be a positive integer`)
          })
        }
      } else if (n.type === 'apex') {
        if (n.treeType !== 'spec') nAt('apex node must have treeType "spec"')
        if (!isStr(n.name)) nAt('apex node must have a name')
        if (!isArr(n.ranks) || n.ranks.length === 0) {
          nAt('apex node must have a non-empty ranks array')
        } else {
          const sum = n.ranks.reduce((s, r) => s + (isInt(r?.maxRanks) ? r.maxRanks : 0), 0)
          if (isInt(n.maxRanks) && sum !== n.maxRanks) {
            nAt(`maxRanks ${n.maxRanks} != sum of rank maxRanks ${sum}`)
          }
        }
        if (!isArr(n.levels)) nAt('apex node must have a levels array')
      } else {
        // round / square
        if (!isStr(n.name)) nAt('must have a name')
        if (!isStr(n.icon)) nAt('must have an icon')
        if (n.choices != null) nAt('non-choice node must have choices = null')
      }

      // Hero membership
      if (n.treeType === 'hero') {
        if (!isStr(n.heroSubtree)) {
          nAt('hero node must have a heroSubtree name')
        } else {
          usedSubtreeNames.add(n.heroSubtree)
          if (subtreeNames.size > 0 && !subtreeNames.has(n.heroSubtree)) {
            nAt(`heroSubtree "${n.heroSubtree}" does not match either heroSubtrees entry`)
          }
        }
      }
    })

    // Every declared subtree should actually have nodes, and vice versa
    for (const name of subtreeNames) {
      if (!usedSubtreeNames.has(name)) at(`heroSubtree "${name}" is declared but no node belongs to it`)
    }
  }

  // ── Cross-check against the classes.json index entry ─────────────────────────
  if (indexEntry) {
    if (indexEntry.id !== data.classId) {
      err(`index id ${indexEntry.id} != classId ${data.classId}`)
    }
    if (indexEntry.name !== data.classSlug) {
      err(`index name "${indexEntry.name}" != classSlug "${data.classSlug}"`)
    }
    for (const s of indexEntry.specs ?? []) {
      const match = data.specs?.[s.name]
      if (!match) err(`index spec "${s.name}" has no entry in specs`)
      else if (match.specId !== s.id) err(`index spec "${s.name}" id ${s.id} != specId ${match.specId}`)
    }
    for (const slug of Object.keys(data.specs ?? {})) {
      if (!(indexEntry.specs ?? []).some((s) => s.name === slug)) {
        err(`spec "${slug}" exists in data but not in the index`)
      }
    }
  }

  return errors
}

/**
 * Throws an Error listing every problem if `data` is invalid.
 * @param {object} data
 * @param {object} [indexEntry]
 */
export function assertValidClassData(data, indexEntry = null) {
  const errors = validateClassData(data, indexEntry)
  if (errors.length > 0) {
    const slug = data?.classSlug ?? 'unknown'
    throw new Error(
      `Invalid class data for "${slug}" (${errors.length} problem${errors.length > 1 ? 's' : ''}):\n` +
      errors.map((e) => `  - ${e}`).join('\n'),
    )
  }
}

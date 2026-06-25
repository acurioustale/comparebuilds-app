/**
 * src/lib/buildString.js
 *
 * Parser and encoder for World of Warcraft talent build strings (the "Midnight"
 * talent system).
 *
 * This is the game's native loadout serialisation — the same string the in-game
 * talent UI exports and that any third-party calculator imports/exports. It is
 * not specific to any one website or data provider; the wire format is fixed by
 * the game. Only the *node list* (see `collectClassNodes`) depends on the data
 * source you ingest, so swapping data sources never changes this file.
 *
 * Binary format:
 *
 *   [ 8 bits]  serialisation version
 *   [16 bits]  spec ID
 *   [128 bits] Blizzard-internal hash (skipped)
 *   per node, in ascending node-ID order across the entire class:
 *     [1]  isSelected
 *     if isSelected:
 *       [1]  isPurchased
 *       if isPurchased:
 *         [1]  isPartiallyRanked
 *         if isPartiallyRanked:
 *           [6]  pointsInvested  (actual rank stored in stream)
 *         [1]  isChoiceNode
 *         if isChoiceNode:
 *           [2]  entryChosen    (0-indexed into choices[])
 *
 * Bit encoding:
 *   - Character table: ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/
 *     (standard RFC 4648 base64)
 *   - Within each 6-bit character, bits are packed LSB-first:
 *       bit j = (charValue >> j) & 1,  for j = 0 … 5
 *   - Multi-bit integers are assembled LSB-first:
 *       result = sum of (bit_i << i)
 *     Example: version=2 (00000010) → stream bytes 01000000
 *              "C0QA" → version=2, specId=269 (Windwalker Monk)
 *
 * Node iteration order (class-level, not spec-level):
 *   The set of all node IDs includes every node across ALL specs of the class
 *   (classNodes + specNodes + hero left/right nodes + apexNode + heroMetaNodeId),
 *   plus any `unusedNodeIds` from the raw class JSON, sorted ascending as integers.
 *   Pass this full set via the `nodes` parameter — see `collectClassNodes()` below
 *   for a helper that builds it from our normalised class data.
 *
 * To target a different data source:
 *   The wire format above is fixed by the game, so it never changes. Build the
 *   node list from whatever source you ingest and pass it to `collectClassNodes()`.
 *   Only swap the CHARSET constant in the unlikely event a source uses a
 *   different 64-character table.
 */

// ─── Serialisation version ─────────────────────────────────────────────────────
// The 8-bit version that opens every string. The bit layout documented above is
// the v2 layout; the game currently emits v2 and we write v2. A different version
// would imply a different layout, so the parsers reject it loudly rather than
// silently misreading every node position. Bump (and update the layout) only when
// the game's format actually changes.
export const SERIALIZATION_VERSION = 2

// ─── Character table ─────────────────────────────────────────────────────────

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** @type {Map<string, number>} char → 0-63 */
const CHAR_TO_VAL = new Map(CHARSET.split('').map((c, i) => [c, i]))

// ─── Bit reader ───────────────────────────────────────────────────────────────

class BitReader {
  /** @type {string} */  #str
  /** @type {number} */  #pos = 0

  /** @param {string} buildString  Base64 string, padding stripped internally. */
  constructor(buildString) {
    this.#str = buildString.replace(/=+$/, '')
  }

  readBit() {
    const charIdx = (this.#pos / 6) | 0
    if (charIdx >= this.#str.length) {
      throw new RangeError(`Build string exhausted at bit ${this.#pos}`)
    }
    const val = CHAR_TO_VAL.get(this.#str[charIdx])
    if (val === undefined) {
      throw new TypeError(`Invalid character '${this.#str[charIdx]}' at index ${charIdx}`)
    }
    // LSB-first within each 6-bit character: bit j = (val >> j) & 1
    const bit = (val >> (this.#pos % 6)) & 1
    this.#pos++
    return bit
  }

  /** Read `count` bits, assembled LSB-first into an unsigned integer. */
  readBits(count) {
    let result = 0
    for (let i = 0; i < count; i++) {
      result |= this.readBit() << i
    }
    return result
  }

  /** Advance position by `count` bits (validates bounds lazily on next readBit). */
  skipBits(count) {
    this.#pos += count
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Builds the full sorted node list that the parser needs from our normalised
 * class data (the objects in src/data/{class}.json).
 *
 * The source code builds this set from ALL specs in the class (not just the
 * active spec): classNodes + specNodes + hero left/right nodes + apexNode id
 * + heroMetaNodeId, deduplicated and sorted ascending.
 *
 * Usage:
 *   import deathKnightData from '../data/death_knight.json'
 *   const nodes = collectClassNodes(deathKnightData)
 *   const build = parseBuildString(str, nodes)
 *
 * @param {object} classData  Normalised class object from src/data/{slug}.json
 * @returns {Array<{ id: number, maxRanks: number, choices: Array<{maxRanks:number}>|null }>}
 */
export function collectClassNodes(classData) {
  /** @type {Map<number, {id:number, maxRanks:number, choices:any}>} */
  const byId = new Map()

  // unusedNodeIds are placeholder IDs in the serialisation space with no talent
  // data. They are always isSelected=0 in real builds, but must be present in the
  // traversal set or all subsequent node bit-positions will be off by their count.
  for (const id of (classData.unusedNodeIds ?? [])) {
    byId.set(id, { id, maxRanks: 1, choices: null })
  }

  for (const spec of Object.values(classData.specs)) {
    for (const node of spec.nodes) {
      if (!byId.has(node.id)) {
        byId.set(node.id, {
          id:       node.id,
          maxRanks: node.maxRanks ?? 1,
          choices:  node.choices ?? null,
        })
      }
    }
    // heroGateNodeId is not in the nodes array but IS in the serialisation space.
    // It is the hero-tree CHOICE node: when selected it carries a 2-bit entryChosen
    // picking the active subtree (0 = left, 1 = right), so model it as a 2-option
    // choice node for correct encoding.
    if (spec.heroGateNodeId != null && !byId.has(spec.heroGateNodeId)) {
      byId.set(spec.heroGateNodeId, {
        id: spec.heroGateNodeId, maxRanks: 1, choices: [{ maxRanks: 1 }, { maxRanks: 1 }],
      })
    }
  }

  return [...byId.values()].sort((a, b) => a.id - b.id)
}

/**
 * Parses a talent build string into a structured representation.
 *
 * Only purchased nodes appear in the returned `nodes` map.
 * `pointsInvested` is always a positive integer (resolved via tree data for
 * fully-purchased nodes where the stream omits the explicit rank).
 * `entryChosen` is `null` for non-choice nodes.
 *
 * @param {string} buildString
 *   Base64-encoded build string (padding optional).
 *
 * @param {Array<{ id: number, maxRanks?: number, choices?: Array<{maxRanks:number}>|null }>} nodes
 *   Complete sorted node list for the class — use `collectClassNodes()` to build it.
 *   Order does not matter; the function sorts by id internally.
 *
 * @returns {{
 *   version: number,
 *   specId:  number,
 *   nodes:   Record<number, { pointsInvested: number, entryChosen: number|null }>
 * }}
 */
export function parseBuildString(buildString, nodes) {
  if (!buildString || typeof buildString !== 'string') {
    throw new TypeError('buildString must be a non-empty string')
  }
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new TypeError('nodes must be a non-empty array')
  }

  const reader = new BitReader(buildString)

  const version = reader.readBits(8)
  if (version !== SERIALIZATION_VERSION) {
    throw new RangeError(`Unsupported build string version ${version} (expected ${SERIALIZATION_VERSION})`)
  }
  const specId  = reader.readBits(16)
  reader.skipBits(128)  // Blizzard internal hash — opaque, carries a real (non-zero) value in game exports but is not needed to decode the selection

  // Sort ascending — must match the order used during serialisation
  const sorted = [...nodes].sort((a, b) => a.id - b.id)

  // Indexed for maxRanks / choices lookups
  const nodeById = new Map(nodes.map((n) => [n.id, n]))

  /** @type {Record<number, {pointsInvested:number, entryChosen:number|null}>} */
  const result = {}

  for (const { id } of sorted) {
    const isSelected = reader.readBit()
    if (!isSelected) continue

    const isPurchased = reader.readBit()
    if (!isPurchased) continue

    const isPartiallyRanked = reader.readBit()

    // Defer resolving "fully purchased" rank until we know entryChosen —
    // choice/apex nodes can have per-option maxRanks that differ from node.maxRanks.
    let partialPoints = null
    if (isPartiallyRanked) {
      partialPoints = reader.readBits(6)
    }

    const isChoiceNode = reader.readBit()
    let entryChosen = null
    if (isChoiceNode) {
      entryChosen = reader.readBits(2)
    }

    // Resolve the node's effective max rank (choice/apex options can differ from
    // node.maxRanks — e.g. an apex with maxRanks=2 or per-option choice ranks).
    const node = nodeById.get(id)
    const effectiveMax =
      isChoiceNode && node?.choices && entryChosen !== null
        ? (node.choices[entryChosen]?.maxRanks ?? 1)
        : (node?.maxRanks ?? 1)

    // Resolve pointsInvested. A partially-ranked stream value is clamped to the
    // node's max so a corrupt or hand-crafted string can't yield ranks like 7/5
    // that would inflate section totals or render nonsensically. Fully-purchased
    // nodes omit the explicit rank and take the max directly.
    const pointsInvested =
      partialPoints !== null ? Math.min(partialPoints, effectiveMax) : effectiveMax

    result[id] = { pointsInvested, entryChosen }
  }

  return { version, specId, nodes: result }
}

// ─── Bit writer ───────────────────────────────────────────────────────────────

class BitWriter {
  #bits = []

  writeBit(bit) { this.#bits.push(bit & 1) }

  // NOTE: only safe for count <= 31 with non-zero values — JS masks shift amounts
  // to 5 bits, so (value >> i) is wrong for i >= 32. All real fields here are <= 16
  // bits; the only wide write is the 128-bit hash, which is always 0.
  writeBits(value, count) {
    for (let i = 0; i < count; i++) this.#bits.push((value >> i) & 1)
  }

  toString() {
    const bits = [...this.#bits]
    while (bits.length % 6 !== 0) bits.push(0)
    let out = ''
    for (let i = 0; i < bits.length; i += 6) {
      let v = 0
      for (let j = 0; j < 6; j++) v |= bits[i + j] << j
      out += CHARSET[v]
    }
    return out
  }
}

/**
 * Encodes a set of node selections into a Blizzard-format talent build string.
 *
 * Matches the game's canonical encoding: auto-granted nodes are written as
 * isSelected=1 / isPurchased=0 (verified against in-game exports), point-purchased
 * nodes as isSelected=1 / isPurchased=1. The hero gate node is encoded like any
 * other purchased node, so include its id in `selectedNodes` when hero talents are
 * invested (the in-game format marks it selected once the gate is unlocked).
 *
 * The 128-bit Blizzard hash is written as zeros — it cannot be reconstructed from
 * the selection alone, so a freshly generated string is not byte-identical to an
 * in-game export, only structurally equivalent.
 *
 * @param {Record<number, {pointsInvested: number, entryChosen: number|null}>} selectedNodes
 * @param {number} specId
 * @param {Array<{id: number, maxRanks: number, choices: Array<{maxRanks:number}>|null}>} classNodes
 *   Full class node list from collectClassNodes() — determines serialisation order.
 * @param {Set<number>} [grantedIds]
 *   Ids of the ACTIVE spec's auto-granted nodes (from treeData). Granted status is
 *   spec-specific, so it cannot be derived from the class-wide node list — pass it
 *   explicitly. Defaults to empty (granted nodes then encode like unselected ones,
 *   which is fine for round-trip tests that never include granted nodes).
 * @returns {string}  Base64 build string (no padding).
 */
export function generateBuildString(selectedNodes, specId, classNodes, grantedIds = new Set()) {
  const writer = new BitWriter()

  writer.writeBits(SERIALIZATION_VERSION, 8) // version
  writer.writeBits(specId, 16)               // specId
  writer.writeBits(0, 128)     // Blizzard hash (zeros)

  const byId = new Map(classNodes.map((n) => [n.id, n]))
  const sorted = [...classNodes].sort((a, b) => a.id - b.id)

  for (const { id } of sorted) {
    // Auto-granted nodes are always present but never point-purchased.
    if (grantedIds.has(id)) {
      writer.writeBit(1) // isSelected
      writer.writeBit(0) // isPurchased
      continue
    }

    const sel = selectedNodes[id]
    if (!sel) { writer.writeBit(0); continue }

    writer.writeBit(1) // isSelected
    writer.writeBit(1) // isPurchased

    const node = byId.get(id)
    const maxRanks =
      node?.choices && sel.entryChosen !== null
        ? (node.choices[sel.entryChosen]?.maxRanks ?? node?.maxRanks ?? 1)
        : (node?.maxRanks ?? 1)

    const partial = sel.pointsInvested < maxRanks
    writer.writeBit(partial ? 1 : 0)
    if (partial) writer.writeBits(sel.pointsInvested, 6)

    const isChoice = node?.choices != null ? 1 : 0
    writer.writeBit(isChoice)
    if (isChoice) writer.writeBits(sel.entryChosen ?? 0, 2)
  }

  return writer.toString()
}

/**
 * Reads only the header of a build string (version + specId) without needing
 * any node data. Used to identify the spec before tree data is loaded.
 *
 * @param {string} buildString
 * @returns {{ version: number, specId: number }}
 */
export function parseSpecId(buildString) {
  if (!buildString || typeof buildString !== 'string') {
    throw new TypeError('buildString must be a non-empty string')
  }
  const reader = new BitReader(buildString)
  const version = reader.readBits(8)
  if (version !== SERIALIZATION_VERSION) {
    throw new RangeError(`Unsupported build string version ${version} (expected ${SERIALIZATION_VERSION})`)
  }
  const specId  = reader.readBits(16)
  return { version, specId }
}

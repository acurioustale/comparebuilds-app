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

import { BitReader, BitWriter } from "./bitStream.js";

// ─── Serialisation version ─────────────────────────────────────────────────────
// The 8-bit version that opens every string. The bit layout documented above is
// the v2 layout; the game currently emits v2 and we write v2. A different version
// would imply a different layout, so the parsers reject it loudly rather than
// silently misreading every node position. Bump (and update the layout) only when
// the game's format actually changes.
export const SERIALIZATION_VERSION = 2;

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
  const byId = new Map();

  // unusedNodeIds are placeholder IDs in the serialisation space with no talent
  // data. They are always isSelected=0 in real builds, but must be present in the
  // traversal set or all subsequent node bit-positions will be off by their count.
  for (const id of classData.unusedNodeIds ?? []) {
    byId.set(id, { id, maxRanks: 1, choices: null });
  }

  for (const spec of Object.values(classData.specs)) {
    for (const node of spec.nodes) {
      if (!byId.has(node.id)) {
        byId.set(node.id, {
          id: node.id,
          maxRanks: node.maxRanks ?? 1,
          choices: node.choices ?? null,
        });
      }
    }
    // heroGateNodeId is not in the nodes array but IS in the serialisation space.
    // It is the hero-tree CHOICE node: when selected it carries a 2-bit entryChosen
    // picking the active subtree (0 = left, 1 = right), so model it as a 2-option
    // choice node for correct encoding.
    if (spec.heroGateNodeId != null && !byId.has(spec.heroGateNodeId)) {
      byId.set(spec.heroGateNodeId, {
        id: spec.heroGateNodeId,
        maxRanks: 1,
        choices: [{ maxRanks: 1 }, { maxRanks: 1 }],
      });
    }
  }

  return [...byId.values()].sort((a, b) => a.id - b.id);
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
// Per-node-list sort + id→node map, memoised by array identity so repeated
// parses against the same classNodes (parseAll, re-parse on add/replace) reuse
// the work instead of rebuilding it each call.
const nodeIndexCache = new WeakMap();
/**
 * @param {Array<{ id: number, maxRanks?: number, choices?: Array<{maxRanks:number}>|null }>} nodes
 * @returns {{ sorted: Array<{ id: number, maxRanks?: number, choices?: Array<{maxRanks:number}>|null }>, nodeById: Map<number, any> }}
 */
function nodeIndex(nodes) {
  const cacheKey = nodes[0] ?? nodes;
  let idx = nodeIndexCache.get(cacheKey);
  if (!idx) {
    idx = {
      sorted: [...nodes].sort((a, b) => a.id - b.id),
      nodeById: new Map(nodes.map((n) => [n.id, n])),
    };
    nodeIndexCache.set(cacheKey, idx);
  }
  return idx;
}

export function parseBuildString(buildString, nodes) {
  if (!buildString || typeof buildString !== "string") {
    throw new TypeError("buildString must be a non-empty string");
  }
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new TypeError("nodes must be a non-empty array");
  }

  const reader = new BitReader(buildString);

  const version = reader.readBits(8);
  if (version !== SERIALIZATION_VERSION) {
    throw new RangeError(
      `Unsupported build string version ${version} (expected ${SERIALIZATION_VERSION})`,
    );
  }
  const specId = reader.readBits(16);
  reader.skipBits(128); // Blizzard internal hash — opaque, carries a real (non-zero) value in game exports but is not needed to decode the selection

  // Sorted-ascending list (must match the serialisation order) plus an id→node
  // map for maxRanks / choices lookups. Both are derived purely from `nodes`, so
  // memoise them by node-list identity: parseAll re-parses every build against
  // the same classNodes array (and the store re-parses on each add/replace), so
  // this builds the sort + Map once per loaded class instead of once per build.
  const { sorted, nodeById } = nodeIndex(nodes);

  /** @type {Record<number, {pointsInvested:number, entryChosen:number|null}>} */
  const result = {};

  for (const { id } of sorted) {
    const isSelected = reader.readBit();
    if (!isSelected) continue;

    const isPurchased = reader.readBit();
    if (!isPurchased) continue;

    const isPartiallyRanked = reader.readBit();

    // Defer resolving "fully purchased" rank until we know entryChosen —
    // choice/apex nodes can have per-option maxRanks that differ from node.maxRanks.
    let partialPoints = null;
    if (isPartiallyRanked) {
      partialPoints = reader.readBits(6);
    }

    const isChoiceNode = reader.readBit();
    let entryChosen = null;
    if (isChoiceNode) {
      entryChosen = reader.readBits(2);
    }

    const node = nodeById.get(id);

    // Normalise entryChosen against the node's real data so a hand-crafted or
    // version-skewed stream can't smuggle a bogus index downstream. A choice node
    // clamps an out-of-range pick into a real option (the 2-bit field encodes 0-3
    // even on a 2-option node, which would otherwise index past choices[] and
    // surface as "option 4" in diff labels / heatmap votes). A node the data
    // treats as non-choice reports entryChosen = null regardless of the stream's
    // isChoiceNode bit — honouring this function's documented contract
    // ("entryChosen is null for non-choice nodes") so diff.js / heatmap.js, which
    // compare entryChosen across every node type, can't read a stray index as a
    // difference. Mirrors the pointsInvested clamp below.
    if (entryChosen !== null) {
      entryChosen =
        node?.choices && node.choices.length > 0
          ? Math.min(entryChosen, node.choices.length - 1)
          : null;
    }

    // Resolve the node's effective max rank (choice/apex options can differ from
    // node.maxRanks — e.g. an apex with maxRanks=2 or per-option choice ranks).
    const effectiveMax =
      isChoiceNode && node?.choices && entryChosen !== null
        ? (node.choices[entryChosen]?.maxRanks ?? 1)
        : (node?.maxRanks ?? 1);

    // Resolve pointsInvested. A partially-ranked stream value is clamped to the
    // node's max so a corrupt or hand-crafted string can't yield ranks like 7/5
    // that would inflate section totals or render nonsensically. Fully-purchased
    // nodes omit the explicit rank and take the max directly.
    const pointsInvested =
      partialPoints !== null
        ? Math.min(partialPoints, effectiveMax)
        : effectiveMax;

    // A purchased node always holds at least one point; a partially-ranked stream
    // value of 0 is nonsensical (corrupt string), so drop it rather than emit a
    // "selected" node with 0 points that would still light up and satisfy prereqs.
    if (pointsInvested < 1) continue;

    result[id] = { pointsInvested, entryChosen };
  }

  return { version, specId, nodes: result };
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
export function generateBuildString(
  selectedNodes,
  specId,
  classNodes,
  grantedIds = new Set(),
) {
  const writer = new BitWriter();

  writer.writeBits(SERIALIZATION_VERSION, 8); // version
  writer.writeBits(specId, 16); // specId
  writer.writeBits(0, 128); // Blizzard hash (zeros)

  const byId = new Map(classNodes.map((n) => [n.id, n]));
  const sorted = [...classNodes].sort((a, b) => a.id - b.id);

  for (const { id } of sorted) {
    // Auto-granted nodes are always present but never point-purchased.
    if (grantedIds.has(id)) {
      writer.writeBit(1); // isSelected
      writer.writeBit(0); // isPurchased
      continue;
    }

    const sel = selectedNodes[id];
    if (!sel) {
      writer.writeBit(0);
      continue;
    }

    writer.writeBit(1); // isSelected
    writer.writeBit(1); // isPurchased

    const node = byId.get(id);
    const isChoice = node?.choices != null;
    // Resolve maxRanks with the SAME entry index we write below (entryChosen ?? 0
    // for a choice node), so the partial flag can't disagree with what decode
    // computes from the written entryChosen when entryChosen is unexpectedly null.
    const entryIdx = sel.entryChosen ?? 0;
    const maxRanks = isChoice
      ? (node.choices[entryIdx]?.maxRanks ?? node?.maxRanks ?? 1)
      : (node?.maxRanks ?? 1);

    const partial = sel.pointsInvested < maxRanks;
    writer.writeBit(partial ? 1 : 0);
    if (partial) writer.writeBits(sel.pointsInvested, 6);

    writer.writeBit(isChoice ? 1 : 0);
    if (isChoice) writer.writeBits(entryIdx, 2);
  }

  return writer.toString();
}

/**
 * The hero-gate node's selection entry for an export, or null when no hero
 * points are invested. The gate is the hero-tree CHOICE node that
 * `collectClassNodes` models as a 2-option node where `entryChosen` 0 = left
 * subtree, 1 = right subtree. This is the single owner of that 0=left/1=right
 * convention, so the encoder and the UI can't disagree on which index means
 * which subtree.
 *
 * @param {number} heroPointsSpent       points invested across the hero section
 * @param {boolean} activeSubtreeIsRight whether the active subtree is the right one
 * @returns {{ pointsInvested: number, entryChosen: number } | null}
 */
export function heroGateSelection(heroPointsSpent, activeSubtreeIsRight) {
  if (!(heroPointsSpent > 0)) return null;
  return { pointsInvested: 1, entryChosen: activeSubtreeIsRight ? 1 : 0 };
}

/**
 * Reads only the header of a build string (version + specId) without needing
 * any node data. Used to identify the spec before tree data is loaded.
 *
 * @param {string} buildString
 * @returns {{ version: number, specId: number }}
 */
export function parseSpecId(buildString) {
  if (!buildString || typeof buildString !== "string") {
    throw new TypeError("buildString must be a non-empty string");
  }
  const reader = new BitReader(buildString);
  const version = reader.readBits(8);
  if (version !== SERIALIZATION_VERSION) {
    throw new RangeError(
      `Unsupported build string version ${version} (expected ${SERIALIZATION_VERSION})`,
    );
  }
  const specId = reader.readBits(16);
  return { version, specId };
}

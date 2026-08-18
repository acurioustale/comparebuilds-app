import classesIndex from "../data/classes.json";
import { parseBuildString, parseSpecId } from "../lib/buildString";
import { pruneInactiveHeroNodes } from "../lib/treeLogic";
import { activeHeroSubtree } from "../lib/treeLogic";

// Vite creates a lazy chunk per matched file. The glob must be a string literal.
// Paths are relative to this file (src/store/ → src/data/). classes.json is the
// statically-imported index, so it's excluded to keep it out of the lazy chunks
// (and to silence Vite's mixed static/dynamic import warning).
const CLASS_MODULES = import.meta.glob([
  "../data/*.json",
  "!../data/classes.json",
]);

// ─── Hero subtree sanitisation ────────────────────────────────────────────────

/**
 * If `nodes` contains selections from more than one hero subtree, strips all
 * but the active one.  Returns `nodes` unchanged when there is zero or one
 * active subtree.
 *
 * "Active" is resolved through the shared `activeHeroSubtree` rule (the first
 * selected, non-granted hero node in node order) — the same single source the
 * spend rules (`canSpendPoint`) and the validity cascade (`computeInvalidNodeIds`)
 * use. Keeping them in lockstep is the point: an imported build that (only a
 * corrupt/hand-built string can) invests in two subtrees must resolve to the
 * SAME legal half whether it is being diffed, validated, or opened to edit. A
 * separate "most points" tie-break here diverged from that rule, so the editor
 * could keep the opposite subtree from the one the comparison views flagged.
 * @param {Record<number, { pointsInvested: number, entryChosen: number|null }>} nodes
 * @param {object|null} treeData
 * @returns {Record<number, { pointsInvested: number, entryChosen: number|null }>}
 */
export function sanitizeHeroSubtrees(nodes, treeData) {
  if (!treeData) return nodes;

  // Collect the selected (non-granted) hero nodes and the distinct subtrees they
  // touch in a single pass. Only these nodes can ever be pruned below — deleting
  // an id that isn't a selection is a no-op — so the removal step iterates this
  // short list instead of re-walking the whole node array.
  const selectedHeroNodes = [];
  const subs = new Set();
  for (const n of treeData.nodes) {
    if (n.treeType === "hero" && !n.alreadyGranted && nodes[n.id]) {
      selectedHeroNodes.push(n);
      subs.add(n.heroSubtree);
    }
  }
  if (subs.size <= 1) return nodes;

  const keepSub = activeHeroSubtree(treeData.nodes, nodes);

  const result = { ...nodes };
  for (const n of selectedHeroNodes) {
    if (n.heroSubtree !== keepSub) delete result[n.id];
  }
  return result;
}

// ─── Module-level helpers ─────────────────────────────────────────────────────

/**
 * Returns the class and spec entry that owns `specId`, or null if not found.
 * @param {number} specId
 * @returns {{ cls: object, spec: object } | null}
 */
export function findClassForSpec(specId) {
  for (const cls of classesIndex) {
    const spec = cls.specs.find((s) => s.id === specId);
    if (spec) return { cls, spec };
  }
  return null;
}

/**
 * Human-readable "<class> — <spec>" label for a spec id, falling back to
 * "spec <id>" when the id isn't in the local index.
 * @param {number} specId
 * @returns {string}
 */
function specLabel(specId) {
  const match = findClassForSpec(specId);
  return match
    ? `${match.cls.displayName} — ${match.spec.displayName}`
    : `spec ${specId}`;
}

/**
 * Parses just the 24-bit spec-identifying header of a build string. Shared by
 * the add and replace paths so their version-vs-corrupt error wording can't
 * drift apart.
 * @param {string} buildString
 * @returns {{ header: { specId: number }, error?: undefined } | { header?: undefined, error: string }}
 */
export function readBuildHeader(buildString) {
  try {
    return { header: parseSpecId(buildString) };
  } catch (err) {
    // Surface the specific reason for an unsupported version; otherwise treat it
    // as an unreadable header (bad base64, truncation, etc.).
    console.error(
      `Failed to parse spec ID from build string: ${err.message}`,
      err,
    );
    const isVersion = err instanceof RangeError && /version/i.test(err.message);
    return {
      error: isVersion
        ? `${err.message}. This build string is from a newer game format than this tool supports.`
        : "Could not read the build string header — it may be truncated or corrupt.",
    };
  }
}

/**
 * The spec-mismatch error message shown when an incoming build targets a
 * different spec than the already-loaded builds. Shared by add and replace so
 * the wording can't drift. Returns null when the specs match (no error).
 * @param {number} currentSpecId
 * @param {number} incomingSpecId
 * @returns {string | null}
 */
export function specMismatchError(currentSpecId, incomingSpecId) {
  if (incomingSpecId === currentSpecId) return null;
  return (
    `Spec mismatch: loaded builds are ${specLabel(currentSpecId)}, ` +
    `but this string is for ${specLabel(incomingSpecId)}.`
  );
}

/**
 * Dynamically imports a normalised class JSON from src/data/.
 * @param {string} classSlug  e.g. "death_knight"
 * @returns {Promise<object>}
 */
export async function importClassData(classSlug) {
  const key = `../data/${classSlug}.json`;
  const loader = CLASS_MODULES[key];
  if (!loader) {
    throw new Error(
      `No local data for "${classSlug}" — run "node scripts/ingestBlizzard.js --promote" to generate it`,
    );
  }
  const mod = await loader();
  return mod.default ?? mod;
}

// WeakMap keyed by `classNodes` array identity -> Map of buildString -> parsed result.
// Memoizes parsed build trees by their individual base64 build string so unmodified
// builds aren't repeatedly unpacked by BitReader during store updates.
const parseCache = new WeakMap();

// Pruned results memoised per (treeData, raw parsed) so a re-parse keeps object
// identity for downstream useMemo. Only ever populated for the builds that
// actually carry an inactive subtree; pruneInactiveHeroNodes returns its input
// untouched otherwise, and that identity flows straight through.
const pruneCache = new WeakMap();

function withActiveHeroOnly(parsed, treeData) {
  if (!parsed || !treeData) return parsed;
  let perTree = pruneCache.get(treeData);
  if (!perTree) {
    perTree = new WeakMap();
    pruneCache.set(treeData, perTree);
  }
  const hit = perTree.get(parsed);
  if (hit) return hit;

  const nodes = pruneInactiveHeroNodes(treeData, parsed.nodes);
  const out = nodes === parsed.nodes ? parsed : { ...parsed, nodes };
  perTree.set(parsed, out);
  return out;
}

/**
 * Parses every build string against the loaded node list, returning null for
 * strings that fail (so the array stays parallel to buildStrings).
 *
 * With `treeData` supplied, each build is reduced to the hero subtree it
 * actually activated. The game exports BOTH hero subtrees' saved choices, so
 * without this a player who has filled both imports with a whole inactive
 * subtree set — invalid nodes in every view, and phantom differences against a
 * build whose owner filled only one. Doing it here rather than in the three
 * views keeps the single-build, diff and heatmap paths from drifting apart.
 *
 * @param {string[]} strings
 * @param {object[]} classNodes
 * @param {object} [treeData] Spec tree data; omit to skip hero pruning
 * @returns {(object|null)[]}
 */
export function parseAll(strings, classNodes, treeData) {
  let cache = parseCache.get(classNodes);
  if (!cache) {
    cache = new Map();
    parseCache.set(classNodes, cache);
  }

  return strings.map((s) => {
    if (cache.has(s)) {
      return withActiveHeroOnly(cache.get(s), treeData);
    }
    let result = null;
    try {
      result = parseBuildString(s, classNodes);
    } catch (err) {
      console.error(`Failed to parse build string: ${err.message}`, err);
    }
    cache.set(s, result);
    return withActiveHeroOnly(result, treeData);
  });
}

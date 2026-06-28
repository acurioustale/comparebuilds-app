import classesIndex from "../data/classes.json";
import { parseBuildString } from "../lib/buildString";
import { spentPoints } from "../lib/treeLogic";

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
 * but the dominant one (highest total points invested).  Returns `nodes`
 * unchanged when there is zero or one active subtree.
 */
export function sanitizeHeroSubtrees(nodes, treeData) {
  if (!treeData) return nodes;

  // Which hero subtrees carry any (non-granted) selected points? Insertion order
  // follows treeData.nodes, which keeps the tie-break below deterministic.
  const subs = new Set();
  for (const n of treeData.nodes) {
    if (n.treeType === "hero" && !n.alreadyGranted && nodes[n.id])
      subs.add(n.heroSubtree);
  }
  if (subs.size <= 1) return nodes;

  // Keep whichever subtree has the most invested points, counted through the
  // shared accumulator so this can't drift from the spend/gate budget logic.
  let keepSub = null;
  let best = -1;
  for (const sub of subs) {
    const pts = spentPoints(treeData.nodes, nodes, "hero", sub);
    if (pts > best) {
      best = pts;
      keepSub = sub;
    }
  }

  const result = { ...nodes };
  for (const n of treeData.nodes) {
    if (
      n.treeType === "hero" &&
      !n.alreadyGranted &&
      n.heroSubtree !== keepSub
    ) {
      delete result[n.id];
    }
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

/**
 * Parses every build string against the loaded node list, returning null for
 * strings that fail (so the array stays parallel to buildStrings).
 * @param {string[]} strings
 * @param {object[]} classNodes
 * @returns {(object|null)[]}
 */
export function parseAll(strings, classNodes) {
  return strings.map((s) => {
    try {
      return parseBuildString(s, classNodes);
    } catch (err) {
      console.error(`Failed to parse build string: ${err.message}`, err);
      return null;
    }
  });
}

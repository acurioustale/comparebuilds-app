import { activeHeroSubtree } from "./treeLogic.js";

/**
 * The ordinal a build is known by across the whole UI.
 *
 * It is the build's *slot* number, except when exactly two builds parse: those
 * two become "A" and "B", matching the paired diff's own red/blue A vs B
 * colouring. Anchoring everything else to the slot keeps the build-manager
 * labels, the comparison panels and the SimC profileset names describing the
 * same build by the same name, and keeps every label distinct — a slot that
 * fails to parse still holds its number, so it can never collide with A/B or
 * with another slot.
 *
 * Deriving A/B from the count of builds that actually *parse* (not the count of
 * slots) is what ties it to the view: it is the parsed builds that select the
 * paired diff, so a corrupt third slot must not make the pair read "1"/"2", and
 * two builds sitting in slots 2 and 3 must still come out as A and B.
 *
 * @param {object} args
 * @param {number} args.slotNumber 1-based build-slot number
 * @param {?number} [args.validRank] 1-based rank among the builds that parsed,
 *   or null/undefined when this build did not parse
 * @param {number} [args.validCount] How many builds parsed in total
 * @returns {string|number} "A", "B", or the slot number
 */
export function buildOrdinal({ slotNumber, validRank = null, validCount = 0 }) {
  if (validCount === 2 && validRank != null) return validRank === 1 ? "A" : "B";
  return slotNumber;
}

/**
 * Builds the default human-readable label for a build slot, e.g.
 * "Build 1 — San'layn Blood Death Knight". Shared by the build-manager slot
 * labels, the comparison panels and the SimulationCraft profileset names so the
 * three can't drift.
 *
 * The hero-spec prefix is derived from the parsed build's active hero subtree
 * when the tree data and parse are available; otherwise it is omitted. When the
 * class/spec display names are absent the label collapses to "Build N".
 *
 * The ordinal is supplied by the caller — see buildOrdinal for the A/B rule.
 *
 * Pure / no-DOM so it lives in src/lib.
 *
 * @param {object} args
 * @param {string|number} args.ordinal Build ordinal shown in the label
 * @param {string} [args.className] Display name of the class
 * @param {string} [args.specName] Display name of the spec
 * @param {object} [args.treeData] Spec tree data definition (needs `.nodes`)
 * @param {object} [args.parsedBuild] Parsed build object (needs `.nodes`)
 * @returns {string} The default build label
 */
export function defaultBuildLabel({
  ordinal,
  className,
  specName,
  treeData,
  parsedBuild,
}) {
  if (!specName || !className) return `Build ${ordinal}`;
  const heroSpec =
    parsedBuild && treeData
      ? activeHeroSubtree(treeData.nodes, parsedBuild.nodes)
      : null;
  const prefix = heroSpec ? `${heroSpec} ` : "";
  return `Build ${ordinal} — ${prefix}${specName} ${className}`;
}

/**
 * src/lib/topBuilds.js
 *
 * Reference builds sourced from Raidbots' public "top sims" summary, generated
 * into src/data/topBuilds.json by scripts/fetchTopBuilds.js.
 *
 * What these are, and what they are not. Raidbots publishes the highest sims it
 * saw in the last 30 days — the top 100 actors per spec — and the generator
 * keeps the most frequently repeated talent strings among them. Most of those
 * sims are Raidbots' optimizer output rather than a player's own picks, so this
 * is "what sims well on a single target", NOT "what the community plays" and not
 * an authority on anything. The UI wording has to keep saying so; a build
 * labelled as popular when it is really an optimiser's answer would quietly
 * mislead. It is also DPS-sim data, so healing and tanking specs are thin or
 * missing entirely — every consumer must handle "no entries for this spec" as
 * an ordinary case, not an error.
 *
 * The table is a committed file, like the class data: the app never talks to
 * Raidbots at runtime. It is loaded lazily because most sessions never ask for
 * it (~34 KB that the paste-a-build-string path has no use for).
 */

/** Human-readable provenance, shown next to the control that loads these. */
export const TOP_BUILDS_SOURCE_URL = "https://www.raidbots.com/developers";

/**
 * Lazily import the generated table. Vite splits it into its own chunk, so a
 * session that never opens the feature never downloads it.
 * @returns {Promise<object>} the parsed topBuilds.json
 */
export async function loadTopBuilds() {
  const mod = await import("../data/topBuilds.json");
  return mod.default ?? mod;
}

/**
 * Entries for one spec, most popular first, or [] when the spec isn't covered.
 *
 * Spec ids are numbers in the app and object keys (therefore strings) in JSON,
 * so the lookup coerces rather than trusting the caller to.
 *
 * @param {object|null} table  parsed topBuilds.json
 * @param {number|null} specId
 * @returns {Array<{talents: string, count: number, topDps: number, topItemLevel: number}>}
 */
export function entriesForSpec(table, specId) {
  if (!table?.specs || specId == null) return [];
  return table.specs[String(specId)] ?? [];
}

/**
 * Pick which reference builds to load into empty slots.
 *
 * Strings already present are skipped rather than reported as an error: the
 * natural second use of the button is "give me the rest", and re-adding a
 * duplicate is refused by addBuild anyway. Returning the survivors keeps that
 * from surfacing as a failure the user has to think about.
 *
 * @param {object}   args
 * @param {Array}    args.entries   entriesForSpec() output
 * @param {string[]} args.existing  build strings already loaded
 * @param {number}   args.limit     free slots
 * @returns {Array<{talents: string, count: number, rank: number}>} in table order
 */
export function selectTopBuilds({ entries, existing = [], limit }) {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const have = new Set(existing);
  const picked = [];
  entries.forEach((entry, i) => {
    if (picked.length >= limit || have.has(entry.talents)) return;
    // Rank is the entry's position in the full table, not in the filtered
    // result: after loading #1 and #2, the next click must offer "#3", not
    // relabel the third build as "#1".
    picked.push({ ...entry, rank: i + 1 });
  });
  return picked;
}

/**
 * Slot name for a reference build. Kept short enough to survive the store's
 * MAX_BUILD_NAME_LEN (40) without truncation.
 *
 * The count is included because it is the whole ranking signal — "#1" alone
 * hides whether it led by a landslide or by a single sim.
 *
 * @param {{rank: number, count: number}} entry
 * @returns {string}
 */
export function topBuildLabel({ rank, count }) {
  return `Top sim #${rank} (${count} sim${count === 1 ? "" : "s"})`;
}

/**
 * scripts/lib/topBuildsCore.js
 * ----------------------------
 * Pure aggregation behind scripts/fetchTopBuilds.js: turns Raidbots' daily
 * "top sims" CSV into the compact per-spec table the app ships.
 *
 * Kept separate from the script so the interesting decisions — what counts as a
 * usable row, how builds are ranked, what gets dropped — are unit-testable
 * without the network. Node-only by convention (build-time); no DOM, no fetch.
 *
 * Ranking is by POPULARITY within the sample, not by DPS. The rows carry a `dps`
 * column, but it is not comparable across them: every actor has different gear
 * and item level, so sorting by it would rank the best-geared character rather
 * than the best build. How many of the top-100 sims independently arrived at the
 * SAME talent string is the signal that survives that, and it is the same
 * "adoption" idea the heatmap view already shows for 3+ builds. `topDps` is kept
 * per entry as context, never as the sort key.
 */

/**
 * One decoded, validated row.
 * @typedef {{specId: number, talents: string, dps: number, itemLevel: number}} TopRow
 */

/** Columns the aggregation requires; a missing one means the upstream shape moved. */
export const REQUIRED_COLUMNS = [
  "class",
  "spec",
  "dps",
  "itemLevel",
  "talents",
  "fightStyle",
  "enemyCount",
];

export function assertColumns(rows) {
  const first = rows[0];
  if (!first) throw new Error("summary.csv had no data rows");
  const missing = REQUIRED_COLUMNS.filter((c) => !(c in first));
  if (missing.length)
    throw new Error(
      `summary.csv is missing expected column(s): ${missing.join(", ")}. ` +
        `The upstream format changed — re-check scripts/fetchTopBuilds.js.`,
    );
}

/**
 * Group validated rows by spec and collapse identical talent strings.
 *
 * @param {TopRow[]} rows
 * @param {number} perSpec how many entries to keep per spec
 * @returns {Record<number, Array<{talents: string, count: number, topDps: number, topItemLevel: number}>>}
 */
export function aggregateBySpec(rows, perSpec) {
  const bySpec = new Map();
  for (const row of rows) {
    let entries = bySpec.get(row.specId);
    if (!entries) bySpec.set(row.specId, (entries = new Map()));
    const seen = entries.get(row.talents);
    if (seen) {
      seen.count++;
      seen.topDps = Math.max(seen.topDps, row.dps);
      seen.topItemLevel = Math.max(seen.topItemLevel, row.itemLevel);
    } else {
      entries.set(row.talents, {
        talents: row.talents,
        count: 1,
        topDps: row.dps,
        topItemLevel: row.itemLevel,
      });
    }
  }

  const out = {};
  for (const [specId, entries] of bySpec) {
    out[specId] = [...entries.values()]
      .sort(
        (a, b) =>
          // Popularity first. Ties break on the best DPS seen for that exact
          // string, then on the string itself so the output is byte-stable
          // across runs on identical input — a regenerated file should diff
          // only where the data actually moved.
          b.count - a.count ||
          b.topDps - a.topDps ||
          (a.talents < b.talents ? -1 : a.talents > b.talents ? 1 : 0),
      )
      .slice(0, perSpec);
  }
  return out;
}

/**
 * Assert the sample is homogeneous before aggregating across it.
 *
 * Today every row is single-target Patchwerk, so the entries in one spec's list
 * are mutually comparable. If Raidbots ever mixes in another fight style or
 * multi-target rows, silently pooling them would put an AoE build and a
 * single-target build side by side under one "top builds" heading and call them
 * alternatives — a wrong answer that looks perfectly normal. Fail instead, so
 * the aggregation is revisited deliberately.
 *
 * @returns {{fightStyle: string, enemyCount: number}} the sample's single shape
 */
export function assertHomogeneous(rows) {
  const styles = new Set(rows.map((r) => r.fightStyle));
  const counts = new Set(rows.map((r) => String(r.enemyCount)));
  if (styles.size !== 1 || counts.size !== 1)
    throw new Error(
      `summary.csv mixes fight styles or target counts (styles: ` +
        `${[...styles].join(", ")}; enemyCount: ${[...counts].join(", ")}). ` +
        `Entries pooled across them would not be comparable — narrow the rows ` +
        `before aggregating.`,
    );
  return {
    fightStyle: [...styles][0],
    enemyCount: Number([...counts][0]),
  };
}

/**
 * Do two generated tables carry the same substance?
 *
 * `generatedAt` moves on every run and `_comment` is prose, so a plain
 * comparison would call every regeneration a change. That matters because the
 * scheduled refresh opens a pull request whenever the file changes: comparing
 * the whole object would open a date-only PR every single run, and a review
 * queue full of no-op diffs is one nobody reads — the same failure the
 * game-build probe avoids by comparing patch versions rather than build numbers.
 *
 * Everything else is compared, including the per-entry counts, so the committed
 * table never displays a sim count that the data no longer supports.
 *
 * @param {object|null} a
 * @param {object|null} b
 * @returns {boolean}
 */
export function sameContent(a, b) {
  if (!a || !b) return false;
  const substance = ({ generatedAt, _comment, ...rest }) => rest; // eslint-disable-line no-unused-vars
  return JSON.stringify(substance(a)) === JSON.stringify(substance(b));
}

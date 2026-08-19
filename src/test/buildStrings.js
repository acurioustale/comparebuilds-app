/**
 * Build strings for the component suites, so BuildManager's and MainView's
 * label tests drive the same inputs.
 */

import { createRequire } from "node:module";
import { collectClassNodes, generateBuildString } from "../lib/buildString.js";

const require = createRequire(import.meta.url);

/** n distinct, valid build strings for one class+spec (selecting 1..n nodes). */
export function genStrings(classSlug, specSlug, n) {
  const data = require(`../data/${classSlug}.json`);
  const classNodes = collectClassNodes(data);
  const spec = data.specs[specSlug];
  const pickable = spec.nodes.filter((nd) => !nd.alreadyGranted);
  const out = [];
  for (let k = 1; k <= n; k++) {
    const sel = {};
    for (let i = 0; i < k; i++) {
      const nd = pickable[i];
      sel[nd.id] = {
        pointsInvested:
          nd.type === "choice" ? nd.choices[0].maxRanks : nd.maxRanks,
        entryChosen: nd.type === "choice" ? 0 : null,
      };
    }
    out.push(generateBuildString(sel, spec.specId, classNodes));
  }
  return out;
}

/**
 * A Blood Death Knight string whose header is intact — version 2, spec 250, so
 * addBuild commits it to a slot — but whose node region is cut short, so the
 * full parse throws and the slot stays unparsed. This is the state a build from
 * a corrupt share link lands in, and the only way a committed slot holds null.
 * Truncated from a real in-game export (see src/lib/buildFixtures.test.js);
 * a densely-packed string is needed, as a sparse generated one still decodes
 * when cut.
 */
export const UNPARSEABLE_BLOOD =
  "CoPAkXBWxkyfx9CbGaHonEAhLxMzyMzMmxMzMMLzMz0MLGjxMGAAAAwMmZmZmZYGDAYmZmZGAAgxsNw";

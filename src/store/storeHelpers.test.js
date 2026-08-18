/**
 * parseAll's hero pruning: the seam where an imported build is reduced to the
 * hero subtree it actually activated.
 *
 * The game persists choices in both hero trees and exports both, so this is the
 * one place that stops a real player's build arriving with a whole inactive
 * subtree set. Doing it here rather than per-view is what keeps the single,
 * diff and heatmap paths from drifting.
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { parseAll } from "./storeHelpers.js";
import { collectClassNodes } from "../lib/buildString.js";

const require = createRequire(import.meta.url);
const druid = require("../data/druid.json");
const guardian = druid.specs.guardian;
const classNodes = collectClassNodes(druid);

// A real in-game export from a character with BOTH druid hero trees filled.
const BOTH_SUBTREES =
  "CgGADBD3hSPCL9Y9gz68WcKvMAAAAAAAAAAAAgZmxsMPwMjZWMLGmZZZgZzwoJamZWmZmZmlxMAAAAAAMjlZALbzMYMLDgpmZZWmZmBAwGmZAWMDGwmFAmZmZDG";

const heroPointsBySubtree = (nodes) => {
  const byId = Object.fromEntries(guardian.nodes.map((n) => [n.id, n]));
  const out = {};
  for (const [id, s] of Object.entries(nodes)) {
    const n = byId[id];
    if (!n || n.alreadyGranted || n.treeType !== "hero") continue;
    out[n.heroSubtree] = (out[n.heroSubtree] ?? 0) + s.pointsInvested;
  }
  return out;
};

test("parseAll without treeData leaves both hero subtrees in place", () => {
  const [parsed] = parseAll([BOTH_SUBTREES], classNodes);
  assert.deepEqual(heroPointsBySubtree(parsed.nodes), {
    "Elune's Chosen": 13,
    "Druid of the Claw": 13,
  });
});

test("parseAll with treeData keeps only the subtree the build activated", () => {
  const [parsed] = parseAll([BOTH_SUBTREES], classNodes, guardian);
  assert.deepEqual(heroPointsBySubtree(parsed.nodes), { "Elune's Chosen": 13 });
});

test("pruning survives the parse cache, which is keyed on the string alone", () => {
  // Warm the cache unpruned, then ask again with treeData: the cached raw parse
  // must still be reduced, or a second slot with the same string would import
  // differently from the first.
  parseAll([BOTH_SUBTREES], classNodes);
  const [again] = parseAll([BOTH_SUBTREES], classNodes, guardian);
  assert.deepEqual(heroPointsBySubtree(again.nodes), { "Elune's Chosen": 13 });
});

test("repeated pruned parses keep object identity for memoisation", () => {
  const [a] = parseAll([BOTH_SUBTREES], classNodes, guardian);
  const [b] = parseAll([BOTH_SUBTREES], classNodes, guardian);
  assert.equal(a, b);
});

test("an unparseable string still yields null in place", () => {
  const out = parseAll(["not-a-build-string"], classNodes, guardian);
  assert.deepEqual(out, [null]);
});

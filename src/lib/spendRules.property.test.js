import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createRequire } from "node:module";
import {
  prunedExportSelection,
  canSpendPoint,
  activeHeroSubtree,
} from "./spendRules.js";
import { buildGrantedSeed } from "./treeLogic.js";

// Property-based coverage for the interactive spend rules and the export pruner.
// Real spec data (druid feral) is the tree; selections are arbitrary. These
// assert the invariants the encoder relies on — the pruned selection is a real,
// canonical subset — and the guard rails on canSpendPoint.

const require = createRequire(import.meta.url);
const treeData = require("../data/druid.json").specs.feral;
const allNodes = treeData.nodes;
const nodeById = Object.fromEntries(allNodes.map((n) => [n.id, n]));
const budget = treeData.pointBudget;
const purchasable = allNodes.filter((n) => !n.alreadyGranted);
const realIds = new Set(allNodes.map((n) => n.id));
// Derived from the data, not a hand-picked range: real feral node ids reach
// into six figures, so a fixed window overlaps them and the "junk" id is
// sometimes a real node that legitimately survives pruning.
const maxRealId = Math.max(...realIds);
const junkIdArb = fc.integer({
  min: maxRealId + 1,
  max: maxRealId + 100000,
});
const grantedSeed = buildGrantedSeed(treeData);

const selectionArb = fc
  .record(
    Object.fromEntries(
      purchasable.map((n) => [
        n.id,
        fc.option(fc.integer({ min: 1, max: n.maxRanks }), { nil: undefined }),
      ]),
    ),
  )
  .map((obj) => {
    const sel = { ...grantedSeed };
    for (const [id, pts] of Object.entries(obj))
      if (pts !== undefined)
        sel[id] = { pointsInvested: pts, entryChosen: null };
    return sel;
  });

describe("prunedExportSelection — property-based", () => {
  it("keeps only real nodes, drops the inactive hero subtree's roots, and is idempotent", () => {
    fc.assert(
      fc.property(selectionArb, junkIdArb, (selected, junkId) => {
        // Seed a bit for an id that isn't a node in this spec (a collapsed
        // duplicate or the hero-gate placeholder) to prove it's dropped.
        const withJunk = {
          ...selected,
          [junkId]: { pointsInvested: 1, entryChosen: null },
        };
        const active = activeHeroSubtree(allNodes, withJunk);
        const pruned = prunedExportSelection(allNodes, withJunk, active);

        for (const id of Object.keys(pruned)) {
          expect(realIds.has(Number(id))).toBe(true); // real nodes only
          expect(withJunk[id]).toBeTruthy(); // subset of the input
        }
        expect(pruned[junkId]).toBeUndefined();

        for (const n of allNodes) {
          if (
            n.alreadyGranted &&
            n.treeType === "hero" &&
            n.heroSubtree !== active
          ) {
            expect(pruned[n.id]).toBeUndefined();
          }
        }

        // Pruning an already-pruned selection changes nothing.
        expect(prunedExportSelection(allNodes, pruned, active)).toEqual(pruned);
      }),
      { numRuns: 50 },
    );
  });
});

describe("canSpendPoint — property-based", () => {
  it("returns a boolean; granted and inactive-hero-subtree nodes are never spendable", () => {
    fc.assert(
      fc.property(
        selectionArb,
        fc.constantFrom(...allNodes.map((n) => n.id)),
        (selected, id) => {
          const node = nodeById[id];
          const can = canSpendPoint(node, allNodes, selected, nodeById, budget);
          expect(typeof can).toBe("boolean");
          if (node.alreadyGranted) expect(can).toBe(false);
          const active = activeHeroSubtree(allNodes, selected);
          if (
            node.treeType === "hero" &&
            active !== null &&
            node.heroSubtree !== active
          ) {
            expect(can).toBe(false);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

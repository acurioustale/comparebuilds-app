/**
 * Tests for the heatmap stats logic extracted from HeatmapTree.
 */

import { describe, test } from "vitest";
import assert from "node:assert/strict";
import {
  rarityTier,
  isContested,
  isDivergent,
  computeStats,
  computeLegendTiers,
} from "./heatmap.js";

describe("rarityTier", () => {
  test("zero adoption is poor", () =>
    assert.strictEqual(rarityTier(0, 4), "poor"));
  test("full adoption is legendary", () =>
    assert.strictEqual(rarityTier(4, 4), "legendary"));
  test(">= 75% is epic", () => assert.strictEqual(rarityTier(3, 4), "epic"));
  test(">= 50% is rare", () => assert.strictEqual(rarityTier(2, 4), "rare"));
  test("below 50% is uncommon", () =>
    assert.strictEqual(rarityTier(1, 4), "uncommon"));
});

describe("isContested", () => {
  test("unanimous adoption is not contested", () =>
    assert.strictEqual(isContested(4, 4), false));
  test("zero adoption is not contested", () =>
    assert.strictEqual(isContested(0, 4), false));
  test("a split is contested", () => {
    assert.strictEqual(isContested(1, 4), true);
    assert.strictEqual(isContested(3, 4), true);
  });
});

describe("isDivergent", () => {
  test("split adoption diverges", () =>
    assert.strictEqual(isDivergent(2, 3, [0, 0, null]), true));
  test("nobody takes it: agreement", () =>
    assert.strictEqual(isDivergent(0, 3, [null, null, null]), false));
  test("all take a ranked/passive node the same way: agreement", () =>
    assert.strictEqual(isDivergent(3, 3, [null, null, null]), false));
  test("all take a choice node with the same pick: agreement", () =>
    assert.strictEqual(isDivergent(3, 3, [1, 1, 1]), false));
  test("all take a choice node but picks diverge: change", () =>
    assert.strictEqual(isDivergent(3, 3, [0, 1, 0]), true));
});

describe("computeStats", () => {
  const NODES = [
    { id: 1, alreadyGranted: false },
    { id: 2, alreadyGranted: false },
    { id: 3, alreadyGranted: true },
  ];
  const sel = (entryChosen = null) => ({ pointsInvested: 1, entryChosen });

  test("counts how many builds selected each node", () => {
    const builds = [{ nodes: { 1: sel() } }, { nodes: { 1: sel(), 2: sel() } }];
    const stats = computeStats(builds, NODES);
    assert.strictEqual(stats[1].count, 2);
    assert.strictEqual(stats[2].count, 1);
  });

  test("alreadyGranted nodes count as every build", () => {
    const builds = [{ nodes: {} }, { nodes: {} }, { nodes: {} }];
    const stats = computeStats(builds, NODES);
    assert.strictEqual(stats[3].count, 3);
    assert.deepStrictEqual(stats[3].choiceVotes, [null, null, null]);
    assert.deepStrictEqual(stats[3].takenBy, [true, true, true]);
  });

  test("choiceVotes records per-build entryChosen, null when unselected", () => {
    const builds = [
      { nodes: { 1: sel(0) } },
      { nodes: {} },
      { nodes: { 1: sel(1) } },
    ];
    const stats = computeStats(builds, NODES);
    assert.deepStrictEqual(stats[1].choiceVotes, [0, null, 1]);
  });

  test("takenBy flags which builds took the node, even for non-choice nodes", () => {
    const builds = [
      { nodes: { 1: sel(), 2: sel() } },
      { nodes: { 1: sel() } },
      { nodes: {} },
    ];
    const stats = computeStats(builds, NODES);
    // node 1: builds 0 and 1 took it; node 2: only build 0. choiceVotes alone
    // can't tell these apart (all null for non-choice), so takenBy is needed.
    assert.deepStrictEqual(stats[1].takenBy, [true, true, false]);
    assert.deepStrictEqual(stats[2].takenBy, [true, false, false]);
  });
});

describe("computeLegendTiers", () => {
  test("zero builds → empty legend", () =>
    assert.deepStrictEqual(computeLegendTiers(0), []));

  test("produces ordered tiers with count ranges", () => {
    const tiers = computeLegendTiers(4);
    const byTier = Object.fromEntries(tiers.map((t) => [t.tier, t.rangeLabel]));
    assert.strictEqual(byTier.legendary, "4/4");
    assert.strictEqual(byTier.poor, "0/4");
    // tiers come back in descending rarity order
    const order = tiers.map((t) => t.tier);
    assert.deepStrictEqual(
      order,
      [...order].sort(
        (a, b) =>
          ["legendary", "epic", "rare", "uncommon", "poor"].indexOf(a) -
          ["legendary", "epic", "rare", "uncommon", "poor"].indexOf(b),
      ),
    );
  });

  test("uses a range label when multiple counts share a tier", () => {
    // With 10 builds, several counts collapse into the same tier → "a–b/10"
    const tiers = computeLegendTiers(10);
    assert.ok(
      tiers.some((t) => t.rangeLabel.includes("–")),
      "expected at least one ranged label",
    );
  });
});

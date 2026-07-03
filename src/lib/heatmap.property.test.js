import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  rarityTier,
  isContested,
  isDivergent,
  computeStats,
  computeLegendTiers,
} from "./heatmap.js";

// Property-based coverage for the adoption/rarity maths. The example tests pin
// the specific thresholds; these assert the invariants across the whole input
// space, so a regression that slips past a hand-picked count still fails.

const TIERS = ["poor", "uncommon", "rare", "epic", "legendary"];
const rank = (t) => TIERS.indexOf(t);

describe("heatmap adoption logic — property-based", () => {
  // 0 <= count <= total, total >= 1.
  const countTotal = fc
    .integer({ min: 1, max: 12 })
    .chain((total) =>
      fc.tuple(fc.integer({ min: 0, max: total }), fc.constant(total)),
    );

  it("rarityTier is a known tier and never gets rarer as adoption grows", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), (total) => {
        for (let c = 0; c <= total; c++)
          expect(TIERS).toContain(rarityTier(c, total));
        expect(rarityTier(0, total)).toBe("poor");
        expect(rarityTier(total, total)).toBe("legendary");
        for (let c = 0; c < total; c++) {
          expect(rank(rarityTier(c + 1, total))).toBeGreaterThanOrEqual(
            rank(rarityTier(c, total)),
          );
        }
      }),
    );
  });

  it("isContested is exactly split adoption", () => {
    fc.assert(
      fc.property(countTotal, ([count, total]) => {
        expect(isContested(count, total)).toBe(count > 0 && count < total);
      }),
    );
  });

  it("isDivergent covers contested adoption and diverging unanimous choices", () => {
    fc.assert(
      fc.property(
        countTotal,
        fc.array(fc.option(fc.integer({ min: 0, max: 3 }), { nil: null })),
        fc.boolean(),
        ([count, total], choiceVotes, isChoiceNode) => {
          const div = isDivergent(count, total, choiceVotes, isChoiceNode);
          if (isContested(count, total)) expect(div).toBe(true);
          if (count === 0) expect(div).toBe(false);
          if (count === total) {
            // A non-choice node all builds take is agreement; a choice node all
            // take diverges if any pick differs OR is unknown (null).
            expect(div).toBe(
              isChoiceNode &&
                choiceVotes.some((v) => v == null || v !== choiceVotes[0]),
            );
          }
        },
      ),
    );
  });

  it("computeLegendTiers lists tiers in order and covers every achievable count", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), (n) => {
        const names = computeLegendTiers(n).map((t) => t.tier);
        const order = ["legendary", "epic", "rare", "uncommon", "poor"];
        const idx = names.map((t) => order.indexOf(t));
        expect(idx).toEqual([...idx].sort((a, b) => a - b)); // in rarity order
        expect(new Set(names).size).toBe(names.length); // no repeats
        for (let c = 0; c <= n; c++) expect(names).toContain(rarityTier(c, n));
      }),
    );
  });

  it("computeLegendTiers(0) is empty", () => {
    expect(computeLegendTiers(0)).toEqual([]);
  });

  it("computeStats keeps count in [0,total] and consistent with takenBy", () => {
    const NODES = [
      { id: 1, alreadyGranted: false },
      { id: 2, alreadyGranted: false },
      { id: 3, alreadyGranted: true },
    ];
    const buildArb = fc.record({
      nodes: fc.dictionary(
        fc.constantFrom("1", "2"),
        fc.record({
          pointsInvested: fc.integer({ min: 1, max: 2 }),
          entryChosen: fc.option(fc.integer({ min: 0, max: 2 }), { nil: null }),
        }),
      ),
    });
    fc.assert(
      fc.property(
        fc.array(buildArb, { minLength: 1, maxLength: 6 }),
        (builds) => {
          const stats = computeStats(builds, NODES);
          const total = builds.length;
          for (const node of NODES) {
            const s = stats[node.id];
            expect(s.count).toBeGreaterThanOrEqual(0);
            expect(s.count).toBeLessThanOrEqual(total);
            expect(s.choiceVotes.length).toBe(total);
            expect(s.takenBy.length).toBe(total);
            expect(s.takenBy.filter(Boolean).length).toBe(s.count);
            if (node.alreadyGranted) expect(s.count).toBe(total);
          }
        },
      ),
    );
  });
});

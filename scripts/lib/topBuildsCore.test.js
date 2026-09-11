import { describe, it, expect } from "vitest";
import {
  aggregateBySpec,
  assertColumns,
  assertHomogeneous,
  sameContent,
  REQUIRED_COLUMNS,
} from "./topBuildsCore.js";

const row = (o) => ({
  specId: 71,
  talents: "A",
  dps: 100,
  itemLevel: 300,
  fightStyle: "Patchwerk",
  enemyCount: "1",
  ...o,
});

describe("assertColumns", () => {
  it("accepts a row carrying every required column", () => {
    const full = Object.fromEntries(REQUIRED_COLUMNS.map((c) => [c, ""]));
    expect(() => assertColumns([full])).not.toThrow();
  });

  it("names the missing columns when the upstream shape moves", () => {
    expect(() => assertColumns([{ class: "warrior" }])).toThrow(/talents/);
  });

  it("rejects an empty file rather than producing an empty table", () => {
    expect(() => assertColumns([])).toThrow(/no data rows/);
  });
});

describe("assertHomogeneous", () => {
  it("returns the sample's single shape", () => {
    expect(assertHomogeneous([row(), row()])).toEqual({
      fightStyle: "Patchwerk",
      enemyCount: 1,
    });
  });

  it("refuses to pool across fight styles", () => {
    // An AoE build and a single-target build listed side by side under one
    // "top builds" heading would read as alternatives to the same question.
    expect(() =>
      assertHomogeneous([row(), row({ fightStyle: "DungeonSlice" })]),
    ).toThrow(/mixes fight styles/);
  });

  it("refuses to pool across target counts", () => {
    expect(() => assertHomogeneous([row(), row({ enemyCount: "5" })])).toThrow(
      /mixes fight styles or target counts/,
    );
  });
});

describe("aggregateBySpec", () => {
  it("collapses identical talent strings and counts them", () => {
    const out = aggregateBySpec(
      [row({ talents: "A" }), row({ talents: "A" }), row({ talents: "B" })],
      5,
    );
    expect(out[71]).toEqual([
      { talents: "A", count: 2, topDps: 100, topItemLevel: 300 },
      { talents: "B", count: 1, topDps: 100, topItemLevel: 300 },
    ]);
  });

  it("ranks by popularity, not by DPS", () => {
    // The dps column is not comparable across rows (different gear and item
    // level), so sorting by it would rank the best-geared character rather than
    // the best build.
    const out = aggregateBySpec(
      [
        row({ talents: "popular" }),
        row({ talents: "popular" }),
        row({ talents: "rich", dps: 999999 }),
      ],
      5,
    );
    expect(out[71].map((e) => e.talents)).toEqual(["popular", "rich"]);
  });

  it("keeps the best dps and item level seen for a string", () => {
    const out = aggregateBySpec(
      [row({ dps: 100, itemLevel: 300 }), row({ dps: 250, itemLevel: 290 })],
      5,
    );
    expect(out[71][0]).toMatchObject({ topDps: 250, topItemLevel: 300 });
  });

  it("separates specs", () => {
    const out = aggregateBySpec([row({ specId: 71 }), row({ specId: 72 })], 5);
    expect(Object.keys(out).sort()).toEqual(["71", "72"]);
  });

  it("truncates each spec to the requested size", () => {
    const rows = ["a", "b", "c", "d"].map((t) => row({ talents: t }));
    expect(aggregateBySpec(rows, 2)[71]).toHaveLength(2);
  });

  it("orders ties deterministically so a regenerated file diffs cleanly", () => {
    // Equal count and equal dps must not leave the order up to insertion, or an
    // unchanged upstream would still produce a churning diff.
    const forward = aggregateBySpec(
      [row({ talents: "b" }), row({ talents: "a" })],
      5,
    );
    const reverse = aggregateBySpec(
      [row({ talents: "a" }), row({ talents: "b" })],
      5,
    );
    expect(forward[71].map((e) => e.talents)).toEqual(["a", "b"]);
    expect(reverse[71].map((e) => e.talents)).toEqual(["a", "b"]);
  });
});

describe("sameContent", () => {
  const file = {
    _comment: "prose",
    source: "https://example.test/summary.csv",
    generatedAt: "2026-01-01",
    fightStyle: "Patchwerk",
    enemyCount: 1,
    specs: { 71: [{ talents: "a", count: 2, topDps: 1, topItemLevel: 300 }] },
  };

  it("ignores the generation date", () => {
    // The scheduled refresh opens a PR whenever the file changes. Comparing the
    // whole object would open a date-only PR on every run, and a review queue
    // of no-op diffs is one nobody reads.
    expect(sameContent(file, { ...file, generatedAt: "2026-06-30" })).toBe(
      true,
    );
  });

  it("ignores the explanatory comment", () => {
    expect(sameContent(file, { ...file, _comment: "reworded" })).toBe(true);
  });

  it("notices a changed talent string", () => {
    const moved = {
      ...file,
      specs: { 71: [{ ...file.specs[71][0], talents: "b" }] },
    };
    expect(sameContent(file, moved)).toBe(false);
  });

  it("notices a changed sim count", () => {
    // Counts are user-visible in the slot label, so a stale one would display a
    // number the data no longer supports.
    const recounted = {
      ...file,
      specs: { 71: [{ ...file.specs[71][0], count: 3 }] },
    };
    expect(sameContent(file, recounted)).toBe(false);
  });

  it("notices a changed sample shape", () => {
    expect(sameContent(file, { ...file, enemyCount: 5 })).toBe(false);
    expect(sameContent(file, { ...file, fightStyle: "DungeonSlice" })).toBe(
      false,
    );
  });

  it("treats a missing side as different, so a first run always writes", () => {
    expect(sameContent(null, file)).toBe(false);
    expect(sameContent(file, null)).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import {
  entriesForSpec,
  selectTopBuilds,
  topBuildLabel,
  loadTopBuilds,
  TOP_BUILDS_SOURCE_URL,
} from "./topBuilds.js";

const table = {
  specs: {
    71: [
      { talents: "a", count: 20, topDps: 3, topItemLevel: 300 },
      { talents: "b", count: 10, topDps: 2, topItemLevel: 300 },
      { talents: "c", count: 5, topDps: 1, topItemLevel: 300 },
    ],
  },
};

describe("entriesForSpec", () => {
  it("looks a numeric spec id up against the JSON's string keys", () => {
    expect(entriesForSpec(table, 71)).toHaveLength(3);
  });

  it("returns an empty list for an uncovered spec", () => {
    // Sim data is DPS-heavy, so healing and tanking specs are routinely absent.
    // That is an ordinary case for the caller, never an error.
    expect(entriesForSpec(table, 270)).toEqual([]);
  });

  it("tolerates a missing table or spec id", () => {
    expect(entriesForSpec(null, 71)).toEqual([]);
    expect(entriesForSpec({}, 71)).toEqual([]);
    expect(entriesForSpec(table, null)).toEqual([]);
  });
});

describe("selectTopBuilds", () => {
  const entries = table.specs[71];

  it("takes the most popular entries up to the free-slot limit", () => {
    const picked = selectTopBuilds({ entries, existing: [], limit: 2 });
    expect(picked.map((p) => p.talents)).toEqual(["a", "b"]);
  });

  it("skips strings already loaded instead of failing", () => {
    const picked = selectTopBuilds({ entries, existing: ["a"], limit: 2 });
    expect(picked.map((p) => p.talents)).toEqual(["b", "c"]);
  });

  it("keeps each entry's rank from the full table", () => {
    // After loading #1, the next pick must still read "#2" — relabelling it
    // "#1" would claim the wrong thing about how popular it is.
    const picked = selectTopBuilds({ entries, existing: ["a"], limit: 1 });
    expect(picked[0]).toMatchObject({ talents: "b", rank: 2 });
  });

  it("returns nothing when there is no room", () => {
    expect(selectTopBuilds({ entries, limit: 0 })).toEqual([]);
    expect(selectTopBuilds({ entries, limit: -1 })).toEqual([]);
    expect(selectTopBuilds({ entries, limit: 1.5 })).toEqual([]);
  });

  it("returns fewer than the limit when the spec has fewer entries", () => {
    expect(selectTopBuilds({ entries, limit: 99 })).toHaveLength(3);
  });

  it("defaults `existing` so a caller may omit it", () => {
    expect(selectTopBuilds({ entries, limit: 1 })).toHaveLength(1);
  });
});

describe("topBuildLabel", () => {
  it("names the rank and how many sims used it", () => {
    expect(topBuildLabel({ rank: 1, count: 62 })).toBe("Top sim #1 (62 sims)");
  });

  it("singularises a lone sim", () => {
    expect(topBuildLabel({ rank: 4, count: 1 })).toBe("Top sim #4 (1 sim)");
  });

  it("stays within the store's 40-character slot-name cap", () => {
    expect(
      topBuildLabel({ rank: 99, count: 100000 }).length,
    ).toBeLessThanOrEqual(40);
  });
});

describe("loadTopBuilds", () => {
  it("resolves the committed table with usable spec entries", async () => {
    const loaded = await loadTopBuilds();
    expect(Object.keys(loaded.specs).length).toBeGreaterThan(0);
    const [specId] = Object.keys(loaded.specs);
    expect(entriesForSpec(loaded, Number(specId)).length).toBeGreaterThan(0);
  });
});

describe("provenance", () => {
  it("points at the Raidbots developer page", () => {
    expect(TOP_BUILDS_SOURCE_URL).toMatch(/^https:\/\/www\.raidbots\.com\//);
  });
});

/**
 * Behaviour tests for addTopBuilds — the store action that fills free slots
 * from the committed Raidbots top-sims table.
 *
 * Drives the real store, so the reference strings go through the same
 * addBuild path (validation, class-data import, parse) as a pasted build.
 */

import { describe, test, beforeEach, expect } from "vitest";
import { createRequire } from "node:module";
import { useBuildsStore, MAX_BUILDS } from "./buildsStore.js";
import { entriesForSpec, topBuildLabel } from "../lib/topBuilds.js";

const require = createRequire(import.meta.url);
const table = require("../data/topBuilds.json");
const classIndex = require("../data/classes.json");
const get = () => useBuildsStore.getState();

// Pick a spec the table actually covers, and one it does not, from the
// committed data rather than hard-coding ids that a regeneration could
// invalidate.
const COVERED = Number(
  Object.keys(table.specs).find((id) => table.specs[id].length >= 2),
);
const UNCOVERED = classIndex
  .flatMap((c) => (c.implemented ? c.specs.map((s) => s.id) : []))
  .find((id) => !(String(id) in table.specs));

beforeEach(() => {
  get().clearAllBuilds();
});

describe("addTopBuilds", () => {
  test("refuses before a spec is chosen", async () => {
    expect(await get().addTopBuilds()).toBe(0);
    expect(get().error).toMatch(/class and spec/i);
  });

  test("fills the free slots with the spec's most popular builds", async () => {
    await get().preloadSpec(COVERED);
    const added = await get().addTopBuilds();

    const entries = entriesForSpec(table, COVERED);
    expect(added).toBe(Math.min(entries.length, MAX_BUILDS));
    expect(get().buildStrings).toEqual(
      entries.slice(0, added).map((e) => e.talents),
    );
    // Every one must have actually parsed — these are shipped strings, so a
    // failure here is a broken slot the user cannot do anything about.
    expect(get().parsedBuilds.filter(Boolean)).toHaveLength(added);
    expect(get().parsedBuilds.every((p) => p.specId === COVERED)).toBe(true);
  });

  test("names each slot by its rank in the table", async () => {
    await get().preloadSpec(COVERED);
    await get().addTopBuilds();
    const entries = entriesForSpec(table, COVERED);
    expect(get().buildNames[0]).toBe(topBuildLabel({ ...entries[0], rank: 1 }));
    expect(get().buildNames[1]).toBe(topBuildLabel({ ...entries[1], rank: 2 }));
  });

  test("adds nothing, and reports no error, for a spec with no sim data", async () => {
    // The sample is DPS-sim data, so healers and tanks are routinely absent.
    // That is an ordinary outcome, not a failure to show the user.
    if (UNCOVERED == null) return;
    await get().preloadSpec(UNCOVERED);
    expect(await get().addTopBuilds()).toBe(0);
    expect(get().error).toBe(null);
  });

  test("skips builds already loaded and continues with the rest", async () => {
    const entries = entriesForSpec(table, COVERED);
    await get().preloadSpec(COVERED);
    await get().addBuild(entries[0].talents);

    const added = await get().addTopBuilds();
    expect(added).toBe(Math.min(entries.length - 1, MAX_BUILDS - 1));
    // The pre-loaded one is not duplicated, and the next pick keeps rank #2.
    expect(new Set(get().buildStrings).size).toBe(get().buildStrings.length);
    expect(get().buildNames[1]).toMatch(/#2/);
  });

  test("is a no-op once every slot is full", async () => {
    await get().preloadSpec(COVERED);
    await get().addTopBuilds();
    const before = get().buildStrings.length;
    if (before < MAX_BUILDS) return; // spec had fewer entries than slots
    expect(await get().addTopBuilds()).toBe(0);
    expect(get().buildStrings).toHaveLength(before);
  });

  test("never exceeds the build limit", async () => {
    await get().preloadSpec(COVERED);
    await get().addTopBuilds();
    expect(get().buildStrings.length).toBeLessThanOrEqual(MAX_BUILDS);
  });
});

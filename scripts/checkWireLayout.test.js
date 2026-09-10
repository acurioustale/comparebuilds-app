import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import {
  parseArgs,
  nodeOrderByClassId,
  diffNodeOrder,
  describeDiff,
  compareAll,
} from "./checkWireLayout.js";
import { collectClassNodes } from "../src/lib/buildString.js";

const require = createRequire(import.meta.url);
const DK = require("../src/data/death_knight.json");
const DK_ORDER = collectClassNodes(DK).map((n) => n.id);
const INDEX = [{ id: DK.classId, name: "death_knight", implemented: true }];
const readClass = () => DK;

/** A minimal talents.json shaped like Raidbots': one entry per spec. */
const talentsFor = (order, { classId = DK.classId, specs = 2 } = {}) =>
  Array.from({ length: specs }, (_, i) => ({
    classId,
    className: "Death Knight",
    specName: `spec${i}`,
    fullNodeOrder: order,
  }));

describe("checkWireLayout parseArgs", () => {
  it("defaults to the live channel with caching on", () => {
    expect(parseArgs([])).toEqual({
      classSlug: null,
      env: "live",
      cache: true,
    });
  });

  it("rejects an empty --class= value", () => {
    // Same hazard as compareSources: an empty slug is falsy, so it would
    // disable the class filter instead of narrowing it.
    expect(() => parseArgs(["--class="])).toThrow(/--class= requires a class/);
  });

  it("rejects an unknown --env= value", () => {
    expect(() => parseArgs(["--env=lve"])).toThrow(
      /unknown Raidbots environment/,
    );
  });

  it("rejects an unknown argument rather than ignoring it", () => {
    expect(() => parseArgs(["--nocache"])).toThrow(/unknown argument/);
  });
});

describe("nodeOrderByClassId", () => {
  it("collapses the per-spec entries into one order per class", () => {
    const byClass = nodeOrderByClassId(talentsFor([1, 2, 3]));
    expect(byClass.get(DK.classId).order).toEqual([1, 2, 3]);
    expect(byClass.get(DK.classId).conflict).toBe(false);
  });

  it("flags specs of one class disagreeing on the order", () => {
    // fullNodeOrder is class-wide, so the specs must agree. If they don't we
    // cannot say which one the game means, and silently picking the first would
    // make the whole check a coin flip.
    const talents = [
      { classId: 6, className: "DK", fullNodeOrder: [1, 2, 3] },
      { classId: 6, className: "DK", fullNodeOrder: [1, 3, 2] },
    ];
    expect(nodeOrderByClassId(talents).get(6).conflict).toBe(true);
  });

  it("treats a missing fullNodeOrder as an empty order rather than throwing", () => {
    expect(nodeOrderByClassId([{ classId: 6 }]).get(6).order).toEqual([]);
  });
});

describe("diffNodeOrder", () => {
  it("matches identical orders", () => {
    const d = diffNodeOrder([1, 2, 3], [1, 2, 3]);
    expect(d.match).toBe(true);
    expect(d.firstMismatchIndex).toBe(-1);
  });

  it("detects a reorder of an otherwise identical node set", () => {
    // The insidious case: nothing was added or removed, so a set comparison
    // would call this equal — but every node from the swap onwards now decodes
    // from a different bit position.
    const d = diffNodeOrder([1, 2, 3], [1, 3, 2]);
    expect(d.match).toBe(false);
    expect(d.firstMismatchIndex).toBe(1);
    expect(d.onlyOurs).toEqual([]);
    expect(d.onlyTheirs).toEqual([]);
    expect(describeDiff(d)).toMatch(/same node set, REORDERED/);
  });

  it("reports nodes a patch added upstream", () => {
    const d = diffNodeOrder([1, 2], [1, 2, 9]);
    expect(d.match).toBe(false);
    expect(d.onlyTheirs).toEqual([9]);
    // A pure append still mismatches on length, and the index reported is the
    // first position that only one side has.
    expect(d.firstMismatchIndex).toBe(2);
  });

  it("reports nodes present only on our side", () => {
    const d = diffNodeOrder([1, 2, 9], [1, 2]);
    expect(d.onlyOurs).toEqual([9]);
    expect(d.match).toBe(false);
  });

  it("truncates long id lists in the description", () => {
    const d = diffNodeOrder([], [1, 2, 3, 4, 5, 6]);
    expect(describeDiff(d)).toMatch(/1, 2, 3, 4, 5, …/);
  });
});

describe("compareAll", () => {
  it("agrees with the real committed data (the oracle, run offline)", () => {
    const { rows, mismatches } = compareAll({
      classIndex: INDEX,
      talents: talentsFor(DK_ORDER),
      readClass,
    });
    expect(mismatches).toBe(0);
    expect(rows[0].ok).toBe(true);
  });

  it("counts a class absent from talents.json as a mismatch", () => {
    // Absence is not agreement: skipping it silently would let the run pass
    // green having compared nothing at all.
    const { rows, mismatches } = compareAll({
      classIndex: INDEX,
      talents: talentsFor(DK_ORDER, { classId: 999 }),
      readClass,
    });
    expect(mismatches).toBe(1);
    expect(rows[0].note).toMatch(/absent from talents.json/);
  });

  it("counts an upstream per-spec conflict as a mismatch", () => {
    const talents = [
      { classId: DK.classId, className: "DK", fullNodeOrder: DK_ORDER },
      { classId: DK.classId, className: "DK", fullNodeOrder: [1, 2] },
    ];
    const { rows, mismatches } = compareAll({
      classIndex: INDEX,
      talents,
      readClass,
    });
    expect(mismatches).toBe(1);
    expect(rows[0].note).toMatch(/specs disagree/);
  });

  it("catches a shifted node order", () => {
    const shifted = [...DK_ORDER.slice(1), DK_ORDER[0]];
    const { mismatches } = compareAll({
      classIndex: INDEX,
      talents: talentsFor(shifted),
      readClass,
    });
    expect(mismatches).toBe(1);
  });
});

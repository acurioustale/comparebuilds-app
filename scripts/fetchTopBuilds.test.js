import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { parseArgs, validateRows, buildFile } from "./fetchTopBuilds.js";
import { parseBuildString, collectClassNodes } from "../src/lib/buildString.js";

const require = createRequire(import.meta.url);
const classIndex = require("../src/data/classes.json");
const topBuilds = require("../src/data/topBuilds.json");
const readClass = (slug) => require(`../src/data/${slug}.json`);

// A real string from the committed table, so the fixture can never drift out of
// sync with the wire format the way a hand-written one would.
const [realSpecId, realEntries] = Object.entries(topBuilds.specs)[0];
const REAL = realEntries[0].talents;
const realClass = classIndex.find((c) =>
  c.specs.some((s) => s.id === Number(realSpecId)),
);

const csvRow = (o = {}) => ({
  class: realClass.name.replace(/_/g, " "),
  spec: "whatever",
  dps: "1000",
  itemLevel: "300",
  talents: REAL,
  fightStyle: "Patchwerk",
  enemyCount: "1",
  ...o,
});

describe("fetchTopBuilds parseArgs", () => {
  it("defaults to a dry run", () => {
    expect(parseArgs([]).write).toBe(false);
  });

  it("rejects a non-positive --per-spec=", () => {
    expect(() => parseArgs(["--per-spec=0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--per-spec=x"])).toThrow(/positive integer/);
  });

  it("rejects an unknown argument rather than ignoring it", () => {
    expect(() => parseArgs(["--wrote"])).toThrow(/unknown argument/);
  });
});

describe("validateRows", () => {
  it("keeps a row whose talents string decodes, tagging it with the decoded spec", () => {
    const { kept, dropped } = validateRows([csvRow()], classIndex, readClass);
    expect(dropped).toEqual([]);
    expect(kept[0]).toMatchObject({
      specId: Number(realSpecId),
      talents: REAL,
      dps: 1000,
    });
  });

  it("drops a row whose talents string does not decode", () => {
    // The generated file is consumed by the app itself, so an undecodable
    // string would surface as a broken slot the user cannot act on.
    const { kept, dropped } = validateRows(
      [csvRow({ talents: "!!!not-base64!!!" })],
      classIndex,
      readClass,
    );
    expect(kept).toEqual([]);
    expect(dropped[0].reason).toMatch(/did not decode/);
  });

  it("drops a class we have no local data for", () => {
    const { kept, dropped } = validateRows(
      [csvRow({ class: "tinkerer" })],
      classIndex,
      readClass,
    );
    expect(kept).toEqual([]);
    expect(dropped[0].reason).toMatch(/no implemented local data/);
  });

  it("maps the CSV's spelled-out class names onto our slugs", () => {
    // Raidbots writes "death knight"; our data files are death_knight.
    const dk = classIndex.find((c) => c.name === "death_knight");
    const entry = Object.entries(topBuilds.specs).find(([id]) =>
      dk.specs.some((s) => s.id === Number(id)),
    );
    const { kept } = validateRows(
      [csvRow({ class: "death knight", talents: entry[1][0].talents })],
      classIndex,
      readClass,
    );
    expect(kept).toHaveLength(1);
  });

  it("drops a row whose decoded spec is not in the local index", () => {
    // Guards the routing assumption: the app looks a spec id up in the index to
    // pick a tree, so an unknown one could never be rendered.
    const stubIndex = classIndex.map((c) =>
      c.name === realClass.name ? { ...c, specs: [] } : c,
    );
    const { dropped } = validateRows([csvRow()], stubIndex, readClass);
    expect(dropped[0].reason).toMatch(/not in the local index/);
  });
});

describe("buildFile", () => {
  it("records the sample shape and the source alongside the entries", () => {
    const { kept } = validateRows([csvRow()], classIndex, readClass);
    const file = buildFile({
      rows: kept,
      perSpec: 5,
      generatedAt: "2026-01-01",
    });
    expect(file).toMatchObject({
      generatedAt: "2026-01-01",
      fightStyle: "Patchwerk",
      enemyCount: 1,
    });
    expect(file.source).toMatch(/raidbots\.com/);
    expect(file.specs[realSpecId]).toHaveLength(1);
  });
});

describe("the committed topBuilds.json", () => {
  it("every shipped talent string decodes against the committed class data", () => {
    // This is the guarantee the whole feature rests on: the app loads these
    // strings directly, so one that no longer parses is a broken slot. It also
    // makes the file a second, independent check on the wire layout — if a data
    // change shifts bit positions, these real in-game strings stop decoding.
    const nodesFor = new Map();
    for (const [specId, entries] of Object.entries(topBuilds.specs)) {
      const cls = classIndex.find((c) =>
        c.specs.some((s) => s.id === Number(specId)),
      );
      expect(cls, `spec ${specId} is in the class index`).toBeTruthy();
      if (!nodesFor.has(cls.name))
        nodesFor.set(cls.name, collectClassNodes(readClass(cls.name)));
      for (const entry of entries) {
        const parsed = parseBuildString(entry.talents, nodesFor.get(cls.name));
        expect(parsed.specId).toBe(Number(specId));
        expect(entry.count).toBeGreaterThan(0);
      }
    }
  });

  it("lists each spec's entries in descending popularity", () => {
    for (const entries of Object.values(topBuilds.specs)) {
      const counts = entries.map((e) => e.count);
      expect(counts).toEqual([...counts].sort((a, b) => b - a));
    }
  });

  it("holds no duplicate strings within a spec", () => {
    for (const [specId, entries] of Object.entries(topBuilds.specs)) {
      const strings = entries.map((e) => e.talents);
      expect(new Set(strings).size, `spec ${specId}`).toBe(strings.length);
    }
  });
});

import { describe, it, expect } from "vitest";
import {
  parseCsv,
  BlizzardDb2,
  renderSpellDescription,
} from "./blizzardDb2.js";

describe("parseCsv", () => {
  it("parses simple rows into objects keyed by header", () => {
    expect(parseCsv("ID,Name\n1,Foo\n2,Bar\n")).toEqual([
      { ID: "1", Name: "Foo" },
      { ID: "2", Name: "Bar" },
    ]);
  });

  it("handles quoted fields with commas, embedded newlines and escaped quotes", () => {
    const csv = 'ID,Desc\n1,"a, b\nc ""q"""\n';
    expect(parseCsv(csv)).toEqual([{ ID: "1", Desc: 'a, b\nc "q"' }]);
  });

  it("tolerates a missing trailing newline and CRLF", () => {
    expect(parseCsv("ID,N\r\n1,x")).toEqual([{ ID: "1", N: "x" }]);
  });

  it("strips a leading UTF-8 BOM so the first header is not corrupted", () => {
    // A BOM (U+FEFF) left in place would key the first column under a
    // BOM-prefixed name, so every .ID lookup would miss and the row Maps
    // would collide under undefined.
    expect(parseCsv("\uFEFFID,Name\n1,Foo")).toEqual([
      { ID: "1", Name: "Foo" },
    ]);
  });
});

// A minimal in-memory trait dataset: one apex capstone (node 100), one ordinary
// node (200), and one points-gated node (300) — mirroring the real table shapes.
function fixture() {
  const db2 = new BlizzardDb2({ build: "test", cache: false });
  db2.index({
    nx: [
      // apex node 100 → three sequential (type-13) entries, out of _Index order
      { TraitNodeID: "100", TraitNodeEntryID: "e2", _Index: "200" },
      { TraitNodeID: "100", TraitNodeEntryID: "e1", _Index: "100" },
      { TraitNodeID: "100", TraitNodeEntryID: "e3", _Index: "300" },
      // ordinary node 200 → one type-2 entry
      { TraitNodeID: "200", TraitNodeEntryID: "e4", _Index: "100" },
    ],
    entry: [
      { ID: "e1", TraitDefinitionID: "d1", MaxRanks: "1", NodeEntryType: "13" },
      { ID: "e2", TraitDefinitionID: "d2", MaxRanks: "2", NodeEntryType: "13" },
      { ID: "e3", TraitDefinitionID: "d3", MaxRanks: "1", NodeEntryType: "13" },
      { ID: "e4", TraitDefinitionID: "d4", MaxRanks: "1", NodeEntryType: "2" },
    ],
    def: [
      { ID: "d1", SpellID: "1001" },
      { ID: "d2", SpellID: "1002" },
      { ID: "d3", SpellID: "1003" },
      { ID: "d4", SpellID: "1004" },
    ],
    cond: [
      // apex per-rank level grants (CondType 5): up to N ranks at level L
      { ID: "L1", CondType: "5", GrantedRanks: "1", RequiredLevel: "81" },
      { ID: "L2", CondType: "5", GrantedRanks: "3", RequiredLevel: "84" },
      { ID: "L3", CondType: "5", GrantedRanks: "4", RequiredLevel: "90" },
      // the real points gate (CondType 0) and two non-gates that must be ignored
      { ID: "g0", CondType: "0", SpentAmountRequired: "8" },
      { ID: "n1", CondType: "1", SpentAmountRequired: "1" },
      { ID: "n2", CondType: "2", SpentAmountRequired: "5" },
    ],
    ncond: [
      { TraitNodeID: "100", TraitCondID: "L1" },
      { TraitNodeID: "100", TraitCondID: "L2" },
      { TraitNodeID: "100", TraitCondID: "L3" },
    ],
    gxn: [
      { TraitNodeGroupID: "grp", TraitNodeID: "300" },
      { TraitNodeGroupID: "grpN", TraitNodeID: "300" },
    ],
    gxc: [
      { TraitNodeGroupID: "grp", TraitCondID: "g0" },
      { TraitNodeGroupID: "grpN", TraitCondID: "n1" },
      { TraitNodeGroupID: "grpN", TraitCondID: "n2" },
    ],
    subtree: [
      { ID: "42", Name_lang: "Sentinel", Description_lang: "Aim true." },
    ],
  });
  return db2;
}

describe("BlizzardDb2.apexChain", () => {
  it("rebuilds the rank chain for an apex node, ordered by _Index", () => {
    const chain = fixture().apexChain("100");
    expect(chain.ranks).toEqual([
      { spellId: 1001, maxRanks: 1 },
      { spellId: 1002, maxRanks: 2 },
      { spellId: 1003, maxRanks: 1 },
    ]);
  });

  it("derives per-rank unlock levels from cumulative GrantedRanks", () => {
    // cumulative after each entry: 1, 3, 4 → levels 81, 84, 90
    expect(fixture().apexChain("100").levels).toEqual([81, 84, 90]);
  });

  it("keeps levels aligned to ranks when grant thresholds aren't sequential", () => {
    // Three single-rank entries (cumulative 1, 2, 3) but grants only at
    // GrantedRanks 1 and 3 — no grant lands exactly on cumulative 2. An
    // exact-match lookup would drop that rank's level, leaving levels shorter
    // than ranks; resolving by coverage (lowest grant with GrantedRanks >= N)
    // keeps them one-to-one.
    const db2 = new BlizzardDb2({ build: "test", cache: false });
    db2.index({
      nx: [
        { TraitNodeID: "100", TraitNodeEntryID: "e1", _Index: "100" },
        { TraitNodeID: "100", TraitNodeEntryID: "e2", _Index: "200" },
        { TraitNodeID: "100", TraitNodeEntryID: "e3", _Index: "300" },
      ],
      entry: [
        {
          ID: "e1",
          TraitDefinitionID: "d1",
          MaxRanks: "1",
          NodeEntryType: "13",
        },
        {
          ID: "e2",
          TraitDefinitionID: "d2",
          MaxRanks: "1",
          NodeEntryType: "13",
        },
        {
          ID: "e3",
          TraitDefinitionID: "d3",
          MaxRanks: "1",
          NodeEntryType: "13",
        },
      ],
      def: [
        { ID: "d1", SpellID: "1001" },
        { ID: "d2", SpellID: "1002" },
        { ID: "d3", SpellID: "1003" },
      ],
      cond: [
        { ID: "L1", CondType: "5", GrantedRanks: "1", RequiredLevel: "80" },
        { ID: "L2", CondType: "5", GrantedRanks: "3", RequiredLevel: "90" },
      ],
      ncond: [
        { TraitNodeID: "100", TraitCondID: "L1" },
        { TraitNodeID: "100", TraitCondID: "L2" },
      ],
      gxn: [],
      gxc: [],
      subtree: [],
    });
    const chain = db2.apexChain("100");
    expect(chain.levels).toHaveLength(chain.ranks.length);
    expect(chain.levels).toEqual([80, 90, 90]);
  });

  it("returns null for an ordinary (non-type-13) node", () => {
    expect(fixture().apexChain("200")).toBeNull();
  });

  it("returns null for an unknown node", () => {
    expect(fixture().apexChain("999")).toBeNull();
  });
});

describe("BlizzardDb2.spentRequired", () => {
  it("reads the CondType-0 gate and ignores type 1/2 conditions", () => {
    expect(fixture().spentRequired("300")).toBe(8);
  });

  it("is 0 for an ungated node", () => {
    expect(fixture().spentRequired("100")).toBe(0);
  });
});

describe("BlizzardDb2.subtree", () => {
  it("returns name and description by id", () => {
    expect(fixture().subtree("42")).toEqual({
      name: "Sentinel",
      description: "Aim true.",
    });
  });

  it("returns null for an unknown subtree", () => {
    expect(fixture().subtree("0")).toBeNull();
  });
});

describe("BlizzardDb2.appliesToSpec", () => {
  // node 10: spec-bound to set 25 at the node level; node 20: spec-bound to set
  // 26 via a group; node 30: a CondType-1 condition with NO SpecSetID (a prereq
  // flag, not a spec gate) → unrestricted.
  function specFixture() {
    const db2 = new BlizzardDb2({ build: "test", cache: false });
    db2.index({
      nx: [],
      entry: [],
      def: [],
      subtree: [],
      cond: [
        { ID: "s25", CondType: "1", SpecSetID: "25" },
        { ID: "s26", CondType: "1", SpecSetID: "26" },
        { ID: "flag", CondType: "1" }, // no SpecSetID
      ],
      ncond: [
        { TraitNodeID: "10", TraitCondID: "s25" },
        { TraitNodeID: "30", TraitCondID: "flag" },
      ],
      gxn: [{ TraitNodeGroupID: "g", TraitNodeID: "20" }],
      gxc: [{ TraitNodeGroupID: "g", TraitCondID: "s26" }],
      specSetMember: [
        { SpecSet: "25", ChrSpecializationID: "270" }, // Mistweaver
        { SpecSet: "26", ChrSpecializationID: "269" }, // Windwalker
      ],
    });
    return db2;
  }

  it("binds a node to its spec set via a node-level condition", () => {
    const db2 = specFixture();
    expect(db2.appliesToSpec("10", "270")).toBe(true);
    expect(db2.appliesToSpec("10", "269")).toBe(false);
  });

  it("resolves a spec condition hung off the node's group", () => {
    const db2 = specFixture();
    expect(db2.appliesToSpec("20", "269")).toBe(true);
    expect(db2.appliesToSpec("20", "270")).toBe(false);
  });

  it("treats a node with no spec-set condition as unrestricted", () => {
    const db2 = specFixture();
    expect(db2.appliesToSpec("30", "999")).toBe(true); // CondType-1 but no SpecSetID
    expect(db2.appliesToSpec("99", "999")).toBe(true); // node never mentioned
  });
});

describe("renderSpellDescription", () => {
  // effect base values indexed by EffectIndex: $s1 → [0], $s2 → [1], etc.
  const effects = new Map([
    [100, [6, 10]], // this spell
    [200, [0, 0, 0, 0, 0, 0, 0, 5]], // cross-spell: $200s8 → index 7 = 5
  ]);
  // OrderIndex 1 → c2, OrderIndex 2 → c3 (Mistweaver/Windwalker shape).
  const tpl =
    "$?c2[Healing increased by $s1%.]?c3[Damage increased by $200s8%.][]";

  it("picks the spec branch by order index and fills $sK", () => {
    expect(
      renderSpellDescription({
        template: tpl,
        orderIndex: 1,
        thisSpellId: 100,
        effects,
      }),
    ).toBe("Healing increased by 6%.");
  });

  it("resolves a cross-spell $<id>sK reference in the chosen branch", () => {
    expect(
      renderSpellDescription({
        template: tpl,
        orderIndex: 2,
        thisSpellId: 100,
        effects,
      }),
    ).toBe("Damage increased by 5%.");
  });

  it("falls to the trailing default branch when none matches", () => {
    expect(
      renderSpellDescription({
        template: tpl,
        orderIndex: 0,
        thisSpellId: 100,
        effects,
      }),
    ).toBe(""); // the [] default is empty
  });

  it("passes a non-conditional template straight through", () => {
    expect(
      renderSpellDescription({
        template: "Increases X by $s2%.",
        orderIndex: 0,
        thisSpellId: 100,
        effects,
      }),
    ).toBe("Increases X by 10%.");
  });

  it("uses the absolute effect value", () => {
    expect(
      renderSpellDescription({
        template: "Reduced by $s1%.",
        orderIndex: 0,
        thisSpellId: 1,
        effects: new Map([[1, [-30]]]),
      }),
    ).toBe("Reduced by 30%.");
  });

  it("returns blank instead of a half-rendered tooltip on unsupported syntax", () => {
    expect(
      renderSpellDescription({
        template: "Lasts $d sec, heals $s1%.",
        orderIndex: 0,
        thisSpellId: 100,
        effects,
      }),
    ).toBe(""); // $d is unhandled → bail
  });

  it("reads $sK by exact EffectIndex when the array is gapped (no neighbour bleed)", () => {
    // _spellEffects indexes by raw EffectIndex, so a spell with effects at index
    // 0 and 2 (index 1 absent) yields a sparse array with a hole at 1. $s1/$s3
    // must read indices 0/2 exactly — a dense push() would misalign $s3 to a
    // hole. Build the hole the same way _spellEffects would.
    const sparse = [];
    sparse[0] = 6;
    sparse[2] = 9; // index 1 left as a hole
    expect(
      renderSpellDescription({
        template: "Deals $s1 then $s3.",
        orderIndex: 0,
        thisSpellId: 100,
        effects: new Map([[100, sparse]]),
      }),
    ).toBe("Deals 6 then 9.");
  });

  it("blanks (never a wrong value) when $sK targets a missing EffectIndex", () => {
    const sparse = [];
    sparse[0] = 6; // index 1 absent → $s2 has no value
    expect(
      renderSpellDescription({
        template: "Heals $s2%.",
        orderIndex: 0,
        thisSpellId: 100,
        effects: new Map([[100, sparse]]),
      }),
    ).toBe(""); // unfilled $s2 survives → bail, rather than show a stale number
  });

  it("blanks (never 'NaN') when an effect value is NaN", () => {
    expect(
      renderSpellDescription({
        template: "Deals $s1% damage.",
        orderIndex: 0,
        thisSpellId: 100,
        // e.g. Number("") on a missing/non-numeric EffectBasePointsF column
        effects: new Map([[100, [NaN]]]),
      }),
    ).toBe("");
  });
});

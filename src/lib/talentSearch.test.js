import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { matchNodeIds } from "./talentSearch.js";

const NODES = [
  {
    id: 1,
    name: "Death Strike",
    description: "Heals you for a percentage of damage taken.",
    choices: null,
  },
  {
    id: 2,
    name: "Blood Boil",
    description: "Deals shadow damage and infects targets with Blood Plague.",
    choices: null,
  },
  {
    id: 3,
    name: null,
    choices: [
      {
        name: "Anti-Magic Barrier",
        description: "Reduces cooldown of Anti-Magic Shell.",
      },
      {
        name: "Death Pact",
        description: "Sacrifice a minion to heal yourself.",
      },
    ],
  },
  {
    id: 4,
    name: "Heart Strike",
    description: "Instantly strike the target and 1 other nearby enemy.",
    choices: null,
  },
];

describe("matchNodeIds", () => {
  test("empty / whitespace query matches nothing", () => {
    assert.strictEqual(matchNodeIds("", NODES).size, 0);
    assert.strictEqual(matchNodeIds("   ", NODES).size, 0);
    assert.strictEqual(matchNodeIds(null, NODES).size, 0);
  });

  test("matches node names case-insensitively, substring", () => {
    assert.deepStrictEqual([...matchNodeIds("strike", NODES)].sort(), [1, 4]);
    // 'death' matches Death Strike (node 1) and the Death Pact choice (node 3).
    assert.deepStrictEqual([...matchNodeIds("DEATH", NODES)].sort(), [1, 3]);
  });

  test("matches any choice option name", () => {
    assert.deepStrictEqual([...matchNodeIds("pact", NODES)], [3]);
    assert.deepStrictEqual([...matchNodeIds("anti-magic", NODES)], [3]);
  });

  test("matches descriptions and choice descriptions case-insensitively", () => {
    assert.deepStrictEqual([...matchNodeIds("plague", NODES)], [2]);
    assert.deepStrictEqual([...matchNodeIds("sacrifice", NODES)], [3]);
    assert.deepStrictEqual([...matchNodeIds("heal", NODES)].sort(), [1, 3]);
  });

  test("no match yields an empty set", () => {
    assert.strictEqual(matchNodeIds("nonexistent", NODES).size, 0);
  });

  test("decodes HTML entities so apostrophes match", () => {
    const nodes = [
      { id: 7, name: "X", description: "reduces the attacker&#39;s speed" },
    ];
    assert.deepStrictEqual([...matchNodeIds("attacker's", nodes)], [7]);
  });

  test("decodes hex numeric entities so apostrophes match", () => {
    const nodes = [
      { id: 9, name: "X", description: "reduces the attacker&#x27;s speed" },
    ];
    assert.deepStrictEqual([...matchNodeIds("attacker's", nodes)], [9]);
  });

  test("strips HTML tags from descriptions", () => {
    const nodes = [
      { id: 8, name: "Y", description: "deals <b>Frost</b> damage" },
    ];
    assert.ok(matchNodeIds("frost damage", nodes).has(8));
  });

  test("matches apex per-rank descriptions", () => {
    const nodes = [
      { id: 9, name: "Apex", ranks: [{ description: "summons a phoenix" }] },
    ];
    assert.ok(matchNodeIds("phoenix", nodes).has(9));
  });

  test("tolerates a missing/!array node list", () => {
    assert.strictEqual(matchNodeIds("x", null).size, 0);
  });
});

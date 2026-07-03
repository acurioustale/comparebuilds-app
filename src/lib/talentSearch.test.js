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

  test("a query with an angle bracket matches literal decoded text", () => {
    // The description stores a literal '<' as the entity &lt;; the query keeps
    // the bracket the user typed (it must not be tag-stripped) so it matches.
    const nodes = [
      { id: 11, name: "Z", description: "hits enemies within &lt;5 yds" },
    ];
    assert.ok(matchNodeIds("<5 yds", nodes).has(11));
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

  test("distinct node lists sharing a first node are indexed independently", () => {
    // The index is memoised by node-list identity. Two lists that share the
    // same first node object must not collide on one cached index — keying on
    // nodes[0] would make the second list reuse the first's stale results.
    const shared = { id: 1, name: "Shared Root", description: "" };
    const listA = [shared, { id: 2, name: "Alpha", description: "" }];
    const listB = [shared, { id: 3, name: "Beta", description: "" }];
    assert.deepStrictEqual([...matchNodeIds("alpha", listA)], [2]);
    assert.deepStrictEqual([...matchNodeIds("beta", listB)], [3]);
    // listB must not answer for Alpha out of listA's cache.
    assert.strictEqual(matchNodeIds("alpha", listB).size, 0);
  });
});

/**
 * Negative-path tests for validateClassData.
 *
 * The integrity suite proves real data PASSES; this proves the validator
 * actually CATCHES the malformations it claims to — otherwise it's a no-op that
 * gives false confidence in the source-independence guarantee.
 */

import { describe, test } from "vitest";
import assert from "node:assert/strict";
import {
  validateClassData,
  assertValidClassData,
} from "./validateClassData.js";

// ── Minimal valid fixture ─────────────────────────────────────────────────────
// One class, one spec, one class node + one hero node per subtree.

function makeValid() {
  return {
    classId: 1,
    classSlug: "test",
    className: "Test",
    unusedNodeIds: [],
    specs: {
      only: {
        specId: 100,
        specSlug: "only",
        pointBudget: { class: 1, spec: 1, hero: 1 },
        checkpoints: { class: [{ row: 2, points: 5 }], spec: [] },
        heroGateNodeId: 9,
        heroSubtrees: {
          left: { name: "Left", icon: "left_icon" },
          right: { name: "Right", icon: "right_icon" },
        },
        nodes: [
          {
            id: 1,
            type: "round",
            treeType: "class",
            posX: 0,
            posY: 0,
            connections: [],
            spentRequired: 0,
            alreadyGranted: false,
            maxRanks: 1,
            name: "Root",
            icon: "a",
            description: null,
            choices: null,
          },
          {
            id: 2,
            type: "hero",
            treeType: "hero",
            heroSubtree: "Left",
            posX: 0,
            posY: 0,
            connections: [],
            spentRequired: 0,
            alreadyGranted: false,
            maxRanks: 1,
            name: "HL",
            icon: "b",
            description: null,
            choices: null,
          },
          {
            id: 3,
            type: "hero",
            treeType: "hero",
            heroSubtree: "Right",
            posX: 0,
            posY: 0,
            connections: [],
            spentRequired: 0,
            alreadyGranted: false,
            maxRanks: 1,
            name: "HR",
            icon: "c",
            description: null,
            choices: null,
          },
        ],
      },
    },
  };
}

const INDEX = { id: 1, name: "test", specs: [{ id: 100, name: "only" }] };

/** Clone, mutate, validate — returns the error list. */
function errorsFor(mutate, indexEntry = null) {
  const d = makeValid();
  if (mutate) mutate(d);
  return validateClassData(d, indexEntry);
}

function assertHasError(errors, substr) {
  assert.ok(
    errors.some((e) => e.includes(substr)),
    `expected an error containing "${substr}", got:\n  ${errors.join("\n  ") || "(none)"}`,
  );
}

// Note: 'round'/'square' validator branch wants name+icon; the fixture's hero
// nodes use type 'hero' which isn't a valid node *type*, so give them a real
// type where the test isn't about that. Fix the fixture's hero node types:
function makeValidFixed() {
  const d = makeValid();
  for (const n of d.specs.only.nodes)
    if (n.treeType === "hero") n.type = "round";
  return d;
}

// ── Happy path ────────────────────────────────────────────────────────────────

describe("happy path", () => {
  test("valid fixture produces no errors", () => {
    assert.deepStrictEqual(validateClassData(makeValidFixed()), []);
  });
  test("valid fixture passes the index cross-check", () => {
    assert.deepStrictEqual(validateClassData(makeValidFixed(), INDEX), []);
  });
  test("assertValidClassData does not throw on valid data", () => {
    assert.doesNotThrow(() => assertValidClassData(makeValidFixed(), INDEX));
  });
});

// ── Top-level fields ──────────────────────────────────────────────────────────

describe("top-level fields", () => {
  test("non-object input", () => {
    assertHasError(validateClassData(null), "must be an object");
    assertHasError(validateClassData(42), "must be an object");
  });
  test("bad classId", () =>
    assertHasError(
      errorsFor((d) => {
        d.classId = "1";
      }),
      "classId must be an integer",
    ));
  test("bad classSlug", () =>
    assertHasError(
      errorsFor((d) => {
        d.classSlug = "";
      }),
      "classSlug must be a non-empty string",
    ));
  test("bad className", () =>
    assertHasError(
      errorsFor((d) => {
        delete d.className;
      }),
      "className must be a non-empty string",
    ));
  test("unusedNodeIds not an array", () =>
    assertHasError(
      errorsFor((d) => {
        d.unusedNodeIds = 5;
      }),
      "unusedNodeIds must be an array",
    ));
  test("unusedNodeIds with non-integers", () =>
    assertHasError(
      errorsFor((d) => {
        d.unusedNodeIds = [1, "x"];
      }),
      "unusedNodeIds must contain only integers",
    ));
  test("specs not an object", () =>
    assertHasError(
      errorsFor((d) => {
        d.specs = [];
      }),
      "specs must be an object",
    ));
  test("specs empty", () =>
    assertHasError(
      errorsFor((d) => {
        d.specs = {};
      }),
      "specs must contain at least one spec",
    ));
});

// ── Spec-level fields ─────────────────────────────────────────────────────────

describe("spec-level fields", () => {
  test("bad specId", () =>
    assertHasError(
      errorsFor((d) => {
        d.specs.only.specId = null;
      }),
      "specId must be an integer",
    ));
  test("specSlug mismatch", () =>
    assertHasError(
      errorsFor((d) => {
        d.specs.only.specSlug = "other";
      }),
      "does not match its key",
    ));
  test("missing pointBudget", () =>
    assertHasError(
      errorsFor((d) => {
        delete d.specs.only.pointBudget;
      }),
      "pointBudget must be an object",
    ));
  test("negative pointBudget value", () =>
    assertHasError(
      errorsFor((d) => {
        d.specs.only.pointBudget.class = -1;
      }),
      "pointBudget.class must be a non-negative integer",
    ));
  test("checkpoints not an object", () =>
    assertHasError(
      errorsFor((d) => {
        d.specs.only.checkpoints = null;
      }),
      "checkpoints must be an object",
    ));
  test("checkpoints.class not an array", () =>
    assertHasError(
      errorsFor((d) => {
        d.specs.only.checkpoints.class = {};
      }),
      "checkpoints.class must be an array",
    ));
  test("checkpoint entry missing fields", () =>
    assertHasError(
      errorsFor((d) => {
        d.specs.only.checkpoints.class = [{ row: 1 }];
      }),
      "must have integer { row, points }",
    ));
  test("bad heroGateNodeId", () =>
    assertHasError(
      errorsFor((d) => {
        d.specs.only.heroGateNodeId = "x";
      }),
      "heroGateNodeId must be an integer or null",
    ));
  test("null heroGateNodeId is allowed", () => {
    const errs = errorsFor((d) => {
      const f = makeValidFixed();
      d.specs = f.specs;
      d.specs.only.heroGateNodeId = null;
    });
    assert.ok(
      !errs.some((e) => e.includes("heroGateNodeId")),
      `unexpected heroGateNodeId error:\n${errs.join("\n")}`,
    );
  });
  test("heroSubtrees missing", () =>
    assertHasError(
      errorsFor((d) => {
        delete d.specs.only.heroSubtrees;
      }),
      "heroSubtrees must be an object",
    ));
  test("heroSubtree missing name", () =>
    assertHasError(
      errorsFor((d) => {
        delete d.specs.only.heroSubtrees.left.name;
      }),
      "heroSubtrees.left.name must be a non-empty string",
    ));
  test("heroSubtree missing icon", () =>
    assertHasError(
      errorsFor((d) => {
        delete d.specs.only.heroSubtrees.right.icon;
      }),
      "heroSubtrees.right.icon must be a non-empty string",
    ));
  test("empty nodes array", () =>
    assertHasError(
      errorsFor((d) => {
        d.specs.only.nodes = [];
      }),
      "nodes must be a non-empty array",
    ));
});

// ── Node-level fields ─────────────────────────────────────────────────────────

describe("node-level fields", () => {
  // start from the fixed fixture (valid node types) and break one node
  function breakNode(mutate) {
    const d = makeValidFixed();
    mutate(d.specs.only.nodes);
    return validateClassData(d);
  }

  test("duplicate node id", () =>
    assertHasError(
      breakNode((nodes) => {
        nodes[1].id = nodes[0].id;
      }),
      "duplicate node id",
    ));
  test("bad type", () =>
    assertHasError(
      breakNode((nodes) => {
        nodes[0].type = "blob";
      }),
      "not in {round,square,choice,apex}",
    ));
  test("bad treeType", () =>
    assertHasError(
      breakNode((nodes) => {
        nodes[0].treeType = "misc";
      }),
      "not in {class,spec,hero}",
    ));
  test("non-finite posX", () =>
    assertHasError(
      breakNode((nodes) => {
        nodes[0].posX = NaN;
      }),
      "posX must be a finite number",
    ));
  test("connections not an integer array", () =>
    assertHasError(
      breakNode((nodes) => {
        nodes[0].connections = ["x"];
      }),
      "connections must be an integer array",
    ));
  test("negative spentRequired", () =>
    assertHasError(
      breakNode((nodes) => {
        nodes[0].spentRequired = -3;
      }),
      "spentRequired must be a non-negative integer",
    ));
  test("non-boolean alreadyGranted", () =>
    assertHasError(
      breakNode((nodes) => {
        nodes[0].alreadyGranted = "yes";
      }),
      "alreadyGranted must be a boolean",
    ));
  test("maxRanks < 1", () =>
    assertHasError(
      breakNode((nodes) => {
        nodes[0].maxRanks = 0;
      }),
      "maxRanks must be a positive integer",
    ));
  test("dangling connection", () =>
    assertHasError(
      breakNode((nodes) => {
        nodes[0].connections = [9999];
      }),
      "references a node not in this spec",
    ));
  test("round node missing name", () =>
    assertHasError(
      breakNode((nodes) => {
        nodes[0].name = null;
      }),
      "must have a name",
    ));
  test("round node with non-null choices", () =>
    assertHasError(
      breakNode((nodes) => {
        nodes[0].choices = [];
      }),
      "non-choice node must have choices = null",
    ));

  test("round node with a path-traversal icon", () =>
    assertHasError(
      breakNode((nodes) => {
        nodes[0].icon = "../../../etc/passwd";
      }),
      "icon must be an icon slug ([A-Za-z0-9_])",
    ));

  test("choice node without choices array", () =>
    assertHasError(
      breakNode((nodes) => {
        nodes[0].type = "choice";
        nodes[0].name = null;
        nodes[0].icon = null;
        nodes[0].choices = null;
      }),
      "choices array of length 2–4",
    ));

  test("choice node with more than 4 choices", () =>
    assertHasError(
      breakNode((nodes) => {
        nodes[0].type = "choice";
        nodes[0].name = null;
        nodes[0].icon = null;
        nodes[0].choices = Array.from({ length: 5 }, (_, i) => ({
          name: `c${i}`,
          icon: "x",
          maxRanks: 1,
        }));
      }),
      "choices array of length 2–4",
    ));

  test("choice option missing fields", () =>
    assertHasError(
      breakNode((nodes) => {
        nodes[0].type = "choice";
        nodes[0].name = null;
        nodes[0].icon = null;
        nodes[0].choices = [
          { name: "X", icon: "x", maxRanks: 1 },
          { name: "", icon: "y", maxRanks: 1 },
        ];
      }),
      "choices[1].name must be a non-empty string",
    ));
});

// ── Apex nodes ────────────────────────────────────────────────────────────────

describe("apex nodes", () => {
  function withApex(apexProps) {
    const d = makeValidFixed();
    d.specs.only.nodes.push({
      id: 50,
      type: "apex",
      treeType: "spec",
      posX: 1,
      posY: 2,
      connections: [],
      spentRequired: 0,
      alreadyGranted: false,
      maxRanks: 3,
      name: "Apex",
      icon: null,
      description: null,
      choices: null,
      levels: [70, 80],
      ranks: [{ maxRanks: 1 }, { maxRanks: 2 }],
      ...apexProps,
    });
    return validateClassData(d);
  }

  test("valid apex passes", () => assert.deepStrictEqual(withApex({}), []));
  test("apex with wrong treeType", () =>
    assertHasError(
      withApex({ treeType: "class" }),
      'apex node must have treeType "spec"',
    ));
  test("apex without name", () =>
    assertHasError(withApex({ name: null }), "apex node must have a name"));
  test("apex without ranks", () =>
    assertHasError(withApex({ ranks: [] }), "non-empty ranks array"));
  test("apex maxRanks != sum of rank maxRanks", () =>
    assertHasError(withApex({ maxRanks: 5 }), "!= sum of rank maxRanks"));
  test("apex without levels", () =>
    assertHasError(withApex({ levels: null }), "must have a levels array"));
  test("apex with a null level entry", () =>
    assertHasError(
      withApex({ levels: [70, null] }),
      "apex node must have a levels array of integers",
    ));
  test("apex levels shorter than ranks", () =>
    assertHasError(
      withApex({ levels: [70] }),
      "apex node levels length 1 must match ranks length 2",
    ));
  test("apex levels longer than ranks", () =>
    assertHasError(
      withApex({ levels: [70, 80, 90] }),
      "apex node levels length 3 must match ranks length 2",
    ));
  test("apex with non-null choices", () =>
    assertHasError(
      withApex({ choices: [{ maxRanks: 1 }, { maxRanks: 1 }] }),
      "apex node must have choices = null",
    ));
});

// ── Hero membership ───────────────────────────────────────────────────────────

describe("hero membership", () => {
  test("hero node missing heroSubtree", () =>
    assertHasError(
      errorsFor((d) => {
        const f = makeValidFixed();
        d.specs = f.specs;
        delete d.specs.only.nodes[1].heroSubtree;
      }),
      "hero node must have a heroSubtree name",
    ));

  test("hero node with unknown subtree", () =>
    assertHasError(
      errorsFor((d) => {
        const f = makeValidFixed();
        d.specs = f.specs;
        d.specs.only.nodes[1].heroSubtree = "Nope";
      }),
      "does not match either heroSubtrees entry",
    ));

  test("declared subtree with no nodes", () =>
    assertHasError(
      errorsFor((d) => {
        const f = makeValidFixed();
        d.specs = f.specs;
        // remove the only "Right" node so heroSubtrees.right has no members
        d.specs.only.nodes = d.specs.only.nodes.filter(
          (n) => n.heroSubtree !== "Right",
        );
      }),
      "is declared but no node belongs to it",
    ));
});

// ── Serialisation-space disjointness ──────────────────────────────────────────

describe("serialisation-space disjointness", () => {
  test("unusedNodeId colliding with a real spec node id is rejected", () => {
    const d = makeValidFixed();
    d.unusedNodeIds = [1]; // id 1 is a real class node
    assertHasError(validateClassData(d), "also appears as a real node id");
  });

  test("unusedNodeId colliding with heroGateNodeId is rejected", () => {
    const d = makeValidFixed();
    d.unusedNodeIds = [9]; // 9 is the spec's heroGateNodeId
    assertHasError(validateClassData(d), "also appears as a real node id");
  });

  test("disjoint unusedNodeIds produce no collision error", () => {
    const d = makeValidFixed();
    d.unusedNodeIds = [1000, 1001];
    const errs = validateClassData(d);
    assert.ok(
      !errs.some((e) => e.includes("also appears as a real node id")),
      `unexpected collision error:\n${errs.join("\n")}`,
    );
  });
});

// ── Index cross-check ─────────────────────────────────────────────────────────

describe("index cross-check", () => {
  const fixed = () => {
    const f = makeValidFixed();
    return f;
  };
  const check = (mutateIndex) => {
    const idx = structuredClone(INDEX);
    mutateIndex(idx);
    return validateClassData(fixed(), idx);
  };

  test("classId mismatch", () =>
    assertHasError(
      check((i) => {
        i.id = 99;
      }),
      "!= classId",
    ));
  test("classSlug mismatch", () =>
    assertHasError(
      check((i) => {
        i.name = "wrong";
      }),
      "!= classSlug",
    ));
  test("index spec missing from data", () =>
    assertHasError(
      check((i) => {
        i.specs.push({ id: 200, name: "ghost" });
      }),
      "has no entry in specs",
    ));
  test("index spec id mismatch", () =>
    assertHasError(
      check((i) => {
        i.specs[0].id = 999;
      }),
      "!= specId",
    ));
  test("data spec not in index", () =>
    assertHasError(
      check((i) => {
        i.specs = [];
      }),
      "exists in data but not in the index",
    ));
});

// ── assertValidClassData ──────────────────────────────────────────────────────

describe("assertValidClassData", () => {
  test("throws with a summary listing problems", () => {
    assert.throws(
      () => assertValidClassData({ classSlug: "broken" }),
      /Invalid class data for "broken"/,
    );
  });
});

import { describe, it, expect } from "vitest";
import {
  normaliseSpec,
  checkpointsFromNodes,
  collapseColocatedDuplicates,
  filterSpecVariants,
  idsUnusedAcrossSpecs,
  parseArgs,
} from "./ingestBlizzard.js";

describe("parseArgs", () => {
  it("rejects --update-snapshot without --promote (a silent no-op otherwise)", () => {
    expect(() => parseArgs(["--update-snapshot"])).toThrow(
      /--update-snapshot requires --promote/,
    );
  });

  it("accepts --update-snapshot alongside --promote", () => {
    const args = parseArgs(["--promote", "--update-snapshot"]);
    expect(args.promote).toBe(true);
    expect(args.updateSnapshot).toBe(true);
  });
});

describe("checkpointsFromNodes", () => {
  it("places one checkpoint per distinct gate at its first (lowest) row, per section, ascending", () => {
    const nodes = [
      { treeType: "class", posY: 0, spentRequired: 0 },
      { treeType: "class", posY: 3, spentRequired: 8 },
      { treeType: "class", posY: 2, spentRequired: 8 }, // lower row, same gate
      { treeType: "class", posY: 6, spentRequired: 23 },
      { treeType: "spec", posY: 5, spentRequired: 20 },
      { treeType: "hero", posY: 1, spentRequired: 0 },
    ];
    expect(checkpointsFromNodes(nodes)).toEqual({
      class: [
        { row: 2, points: 8 },
        { row: 6, points: 23 },
      ],
      spec: [{ row: 5, points: 20 }],
    });
  });
});

// A node in the Game Data API's per-spec shape.
function node(id, type, opts = {}) {
  const ranks =
    opts.empty || type === "CHOICE_GATE"
      ? [{ rank: 1 }] // spell-less placeholder / gate
      : [
          {
            rank: 1,
            tooltip: {
              talent: { name: `n${id}` },
              spell_tooltip: { spell: { id: 9000 + id }, description: "d" },
            },
          },
        ];
  return {
    id,
    node_type: { type: type === "CHOICE_GATE" ? "CHOICE" : type },
    ranks,
    display_row: opts.row ?? 1,
    display_col: opts.col ?? 1,
    locked_by: opts.locked_by ?? [],
  };
}

const DB2_STUB = {
  apexChain: () => null,
  spentRequired: () => 0,
  subtree: (id) => ({ name: `sub${id}`, description: `desc-${id}` }),
  appliesToSpec: () => true,
  descriptionFor: async () => "",
};
const FNS = {
  iconOf: async () => "icon",
  descOf: () => "desc",
  spellDescOf: async () => "",
  renderClientDesc: async () => "",
};

async function build() {
  const tree = {
    class_talent_nodes: [
      node(1, "PASSIVE", { row: 1, col: 1 }),
      node(2, "CHOICE_GATE", { row: 1, col: 5 }), // the hero gate (spell-less)
      node(3, "ACTIVE", { row: 0, col: 9, empty: true }), // reserved placeholder
    ],
    spec_talent_nodes: [
      node(4, "PASSIVE", { row: 6, col: 15 }),
      node(5, "PASSIVE", { row: 2, col: 9 }), // also a hero node (embedded) → dedup
      node(6, "PASSIVE", { row: 3, col: 9, locked_by: [5] }),
    ],
    hero_talent_trees: [
      {
        id: 43, // higher id → right
        name: "Dark Ranger",
        playable_specializations: [{ id: 100 }],
        hero_talent_nodes: [
          node(7, "PASSIVE", { row: 2, col: 9 }),
          node(8, "PASSIVE", { row: 3, col: 9, locked_by: [7] }),
        ],
      },
      {
        id: 42, // lower id → left
        name: "Sentinel",
        playable_specializations: [{ id: 100 }],
        hero_talent_nodes: [
          node(5, "PASSIVE", { row: 2, col: 9 }),
          node(6, "PASSIVE", { row: 3, col: 9, locked_by: [5] }),
        ],
      },
      {
        id: 99, // does NOT apply to this spec → filtered out
        name: "Other",
        playable_specializations: [{ id: 999 }],
        hero_talent_nodes: [node(50, "PASSIVE")],
      },
    ],
  };
  const specInfo = {
    id: 100,
    name: "testspec",
    displayName: "Test Spec",
    color: "#fff",
    icon: "i",
    description: "d",
  };
  return normaliseSpec(specInfo, tree, DB2_STUB, FNS);
}

describe("normaliseSpec", () => {
  it("lifts the hero gate out of the nodes and records heroGateNodeId", async () => {
    const spec = await build();
    expect(spec.heroGateNodeId).toBe(2);
    expect(spec.nodes.find((n) => n.id === 2)).toBeUndefined();
  });

  it("excludes spell-less placeholder nodes from the talent list", async () => {
    const spec = await build();
    expect(spec.nodes.find((n) => n.id === 3)).toBeUndefined();
  });

  it("sources hero nodes once, as treeType hero with their subtree", async () => {
    const spec = await build();
    const ids = spec.nodes.map((n) => n.id).sort((a, b) => a - b);
    expect(ids).toEqual([1, 4, 5, 6, 7, 8]); // no dup of 5/6, no out-of-spec 50
    const n5 = spec.nodes.find((n) => n.id === 5);
    expect(n5.treeType).toBe("hero");
    expect(n5.heroSubtree).toBe("Sentinel");
    expect(spec.nodes.find((n) => n.id === 1).treeType).toBe("class");
    expect(spec.nodes.find((n) => n.id === 4).treeType).toBe("spec");
  });

  it("auto-grants hero roots (no in-tree prereq) but not their children", async () => {
    const spec = await build();
    expect(spec.nodes.find((n) => n.id === 5).alreadyGranted).toBe(true); // root
    expect(spec.nodes.find((n) => n.id === 6).alreadyGranted).toBe(false); // child
  });

  it("orders hero subtrees left/right by id and fills descriptions from DB2", async () => {
    const spec = await build();
    expect(spec.heroSubtrees.left.name).toBe("Sentinel"); // id 42
    expect(spec.heroSubtrees.right.name).toBe("Dark Ranger"); // id 43
    expect(spec.heroSubtrees.left.description).toBe("desc-42");
  });

  // The hero budget caps both subtrees with one number; when the two differ in
  // spendable size it must be the LARGER, or a build in the bigger subtree gets
  // blocked from spending its last legitimate point.
  it("sizes the hero budget from the larger subtree, not just the left one", async () => {
    const tree = {
      class_talent_nodes: [node(1, "PASSIVE", { row: 1, col: 1 })],
      spec_talent_nodes: [],
      hero_talent_trees: [
        {
          id: 42, // left — 1 spendable node (root + one child)
          name: "Small",
          playable_specializations: [{ id: 100 }],
          hero_talent_nodes: [
            node(10, "PASSIVE", { row: 1, col: 1 }), // root → granted
            node(11, "PASSIVE", { row: 2, col: 1, locked_by: [10] }),
          ],
        },
        {
          id: 43, // right — 2 spendable nodes (root + two children)
          name: "Big",
          playable_specializations: [{ id: 100 }],
          hero_talent_nodes: [
            node(20, "PASSIVE", { row: 1, col: 1 }), // root → granted
            node(21, "PASSIVE", { row: 2, col: 1, locked_by: [20] }),
            node(22, "PASSIVE", { row: 3, col: 1, locked_by: [20] }),
          ],
        },
      ],
    };
    const specInfo = {
      id: 100,
      name: "testspec",
      displayName: "Test Spec",
      color: "#fff",
      icon: "i",
      description: "d",
    };
    const spec = await normaliseSpec(specInfo, tree, DB2_STUB, FNS);
    expect(spec.pointBudget.hero).toBe(2); // max(left 1, right 2), not the left's 1
  });

  // A choice option with no talent name, no spell name, and no spell id must not
  // ship the literal string "undefined" as its name/icon (which would pass the
  // non-empty-string validator and render a talent literally called "undefined").
  it("falls back to the node id, not 'undefined', for a choice option with no spell", async () => {
    const choiceNode = {
      id: 30,
      node_type: { type: "CHOICE" },
      ranks: [
        {
          rank: 1,
          choice_of_tooltips: [
            {
              talent: { name: "Opt A" },
              spell_tooltip: { spell: { id: 555 }, description: "d" },
            },
            // Degenerate option: no talent name, no spell name, no spell id.
            { spell_tooltip: { description: "d" } },
          ],
        },
      ],
      display_row: 1,
      display_col: 3,
      locked_by: [],
    };
    const tree = {
      class_talent_nodes: [node(1, "PASSIVE", { row: 1, col: 1 }), choiceNode],
      spec_talent_nodes: [],
      hero_talent_trees: [],
    };
    const specInfo = {
      id: 100,
      name: "testspec",
      displayName: "Test Spec",
      color: "#fff",
      icon: "i",
      description: "d",
    };
    // iconOf returns null for the id-less option so the icon fallback is exercised.
    const fns = {
      ...FNS,
      iconOf: async (id) => (id == null ? null : "icon"),
    };
    const spec = await normaliseSpec(specInfo, tree, DB2_STUB, fns);
    const choice = spec.nodes.find((n) => n.id === 30);
    expect(choice.choices).toHaveLength(2);
    expect(choice.choices[0].name).toBe("Opt A");
    expect(choice.choices[1].name).toBe("30"); // node id, not "undefined"
    expect(choice.choices[1].icon).toBe("30");
  });
});

describe("filterSpecVariants", () => {
  const heroNode = (id, posX, posY, connections = []) => ({
    id,
    treeType: "hero",
    heroSubtree: "S",
    posX,
    posY,
    connections,
    alreadyGranted: false,
  });

  it("does not grant a hero node whose only prereq is filtered out of the spec", () => {
    // Node 99 is out-of-spec and shares a cell with the in-spec node 8, so the
    // variant filter drops it. Node 7's sole prereq is 99, so after the
    // connection prune 7 has zero connections — but it is NOT a root and must
    // stay ungranted; only the true root (5, no prereqs) is auto-granted.
    const db2 = { appliesToSpec: (id) => id !== 99 };
    const built = [
      heroNode(5, 0, 0), // true root
      heroNode(7, 2, 2, [99]), // sole prereq is out-of-spec
      heroNode(99, 4, 4), // out-of-spec, dropped
      heroNode(8, 4, 4), // in-spec native variant of the same cell
    ];

    const out = filterSpecVariants(built, 100, db2);

    expect(out.find((n) => n.id === 99)).toBeUndefined();
    expect(out.find((n) => n.id === 5).alreadyGranted).toBe(true);
    const n7 = out.find((n) => n.id === 7);
    expect(n7.alreadyGranted).toBe(false);
    expect(n7.connections).toEqual([]);
  });
});

describe("collapseColocatedDuplicates", () => {
  const mk = (id, name, posX, posY, opts = {}) => ({
    id,
    name,
    treeType: "class",
    heroSubtree: null,
    posX,
    posY,
    alreadyGranted: false,
    connections: [],
    ...opts,
  });

  it("collapses same-name co-located nodes to the lowest id and prunes connections", () => {
    // Same cell, same talent name — one slot (mirrors Starfire / Moonkin Form).
    const spec = {
      nodes: [
        mk(10, "Starfire", 2, 0),
        mk(11, "Starfire", 2, 0), // duplicate id for the same slot
        mk(20, "Wrath", 2, 1, { connections: [10, 11] }), // downstream wired to both
      ],
    };
    expect(collapseColocatedDuplicates(spec)).toEqual([11]);
    expect(spec.nodes.map((n) => n.id)).toEqual([10, 20]);
    expect(spec.nodes.find((n) => n.id === 20).connections).toEqual([10]);
  });

  it("collapses a same-name pair even when the cell spans a base/talent variant", () => {
    // Moonkin Form: 82208 (base-form spell) + 91047 (talent variant) at one cell;
    // both named "Moonkin Form", so the lowest id wins (matches the game export).
    const spec = {
      nodes: [
        mk(82208, "Moonkin Form", 18, 4),
        mk(91047, "Moonkin Form", 18, 4),
      ],
    };
    expect(collapseColocatedDuplicates(spec)).toEqual([91047]);
    expect(spec.nodes.map((n) => n.id)).toEqual([82208]);
  });

  it("keeps co-located nodes with DIFFERENT names (not the same slot)", () => {
    const spec = {
      nodes: [mk(30, "Foo", 4, 0), mk(31, "Bar", 4, 0)],
    };
    expect(collapseColocatedDuplicates(spec)).toEqual([]);
    expect(spec.nodes.map((n) => n.id)).toEqual([30, 31]);
  });

  it("never touches granted co-located nodes", () => {
    const spec = {
      nodes: [
        mk(10, "Halo", 2, 0, { alreadyGranted: true }),
        mk(11, "Halo", 2, 0, { alreadyGranted: true }),
      ],
    };
    expect(collapseColocatedDuplicates(spec)).toEqual([]);
    expect(spec.nodes.map((n) => n.id)).toEqual([10, 11]);
  });
});

describe("idsUnusedAcrossSpecs", () => {
  it("keeps a dropped id that is a real node in no spec", () => {
    const specs = {
      A: { nodes: [{ id: 1 }, { id: 2 }] },
      B: { nodes: [{ id: 1 }, { id: 3 }] },
    };
    // 200 was dropped everywhere; it survives as a real node in neither spec.
    expect(idsUnusedAcrossSpecs(new Set([200]), specs)).toEqual([200]);
  });

  it("excludes a dropped id that survives as a real node in another spec", () => {
    // Spec A collapsed the co-located pair (100, 200) → dropped 200. Spec B kept
    // only 200 (no partner to collapse), so 200 is still a real node there. It
    // must NOT be promoted to unusedNodeIds, or the disjointness check aborts.
    const specs = {
      A: { nodes: [{ id: 100 }] },
      B: { nodes: [{ id: 200 }] },
    };
    expect(idsUnusedAcrossSpecs(new Set([200]), specs)).toEqual([]);
  });
});

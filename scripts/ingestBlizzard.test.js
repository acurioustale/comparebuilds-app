import { describe, it, expect } from "vitest";
import { normaliseSpec, checkpointsFromNodes } from "./ingestBlizzard.js";

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
});

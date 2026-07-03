import { describe, test, expect } from "vitest";
import { createRequire } from "node:module";
import { buildExportString } from "./exportBuild.js";
import { collectClassNodes, parseBuildString } from "./buildString.js";
import { activeHeroSubtree } from "./treeLogic.js";

const require = createRequire(import.meta.url);

describe("buildExportString", () => {
  test("returns empty string on missing arguments", () => {
    expect(buildExportString(null, {}, 1, [])).toBe("");
    expect(buildExportString({}, {}, null, [])).toBe("");
    expect(buildExportString({}, {}, 1, null)).toBe("");
  });

  test("round-trips an interactive selection through buildExportString and parseBuildString", () => {
    const dk = require("../data/death_knight.json");
    const classNodes = collectClassNodes(dk);
    const spec = dk.specs.blood;
    const treeData = {
      nodes: spec.nodes,
      pointBudget: { class: 31, spec: 30, hero: 10 },
      heroSubtrees: spec.heroSubtrees,
      heroGateNodeId: spec.heroGateNodeId,
    };

    const pickable = spec.nodes.filter((nd) => !nd.alreadyGranted);
    const pick = pickable[0];
    const selected = {
      [pick.id]: {
        pointsInvested:
          pick.type === "choice" ? pick.choices[0].maxRanks : pick.maxRanks,
        entryChosen: pick.type === "choice" ? 0 : null,
      },
    };

    const str = buildExportString(treeData, selected, spec.specId, classNodes);
    expect(typeof str).toBe("string");
    expect(str.length).toBeGreaterThan(0);

    const parsed = parseBuildString(str, classNodes);
    expect(parsed.specId).toBe(spec.specId);
    expect(parsed.nodes[pick.id]).toEqual(selected[pick.id]);
  });

  test("exports only the active hero subtree from a dual-subtree selection, with the matching gate", () => {
    // A corrupt/tool-built selection with purchased picks in BOTH hero subtrees.
    // The export must keep only the active subtree (the first hero pick in node
    // order), drop the other subtree entirely, and inject a gate that points at
    // the active subtree — never a gate with no active-subtree points behind it.
    const dk = require("../data/death_knight.json");
    const classNodes = collectClassNodes(dk);
    const spec = dk.specs.blood;
    const treeData = {
      nodes: spec.nodes,
      pointBudget: { class: 31, spec: 30, hero: 10 },
      heroSubtrees: spec.heroSubtrees,
      heroGateNodeId: spec.heroGateNodeId,
    };

    const heroNodes = spec.nodes.filter(
      (nd) => nd.treeType === "hero" && !nd.alreadyGranted,
    );
    const leftNode = heroNodes.find(
      (nd) => nd.heroSubtree === spec.heroSubtrees.left.name,
    );
    const rightNode = heroNodes.find(
      (nd) => nd.heroSubtree === spec.heroSubtrees.right.name,
    );
    const selected = {
      [leftNode.id]: { pointsInvested: 1, entryChosen: null },
      [rightNode.id]: { pointsInvested: 1, entryChosen: null },
    };

    const activeSub = activeHeroSubtree(spec.nodes, selected);
    const str = buildExportString(treeData, selected, spec.specId, classNodes);
    const parsed = parseBuildString(str, classNodes);
    const byId = Object.fromEntries(spec.nodes.map((n) => [n.id, n]));
    const exportedHeroSubtrees = Object.keys(parsed.nodes)
      .map(Number)
      .filter((id) => byId[id]?.treeType === "hero" && !byId[id].alreadyGranted)
      .map((id) => byId[id].heroSubtree);

    // Only the active subtree's pick survives — the inactive one is pruned.
    expect(exportedHeroSubtrees).toEqual([activeSub]);
    // A gate is present and selects the active subtree (0 = left, 1 = right).
    expect(parsed.nodes[spec.heroGateNodeId]).toEqual({
      pointsInvested: 1,
      entryChosen: activeSub === spec.heroSubtrees.right.name ? 1 : 0,
    });
  });

  test("throws when the active hero subtree matches neither gate slot", () => {
    const dk = require("../data/death_knight.json");
    const classNodes = collectClassNodes(dk);
    const spec = dk.specs.blood;
    // Rename both hero subtrees so the selected hero node's heroSubtree value
    // matches neither — simulating a data/ingest drift the export must reject
    // loudly rather than silently encoding the wrong gate.
    const treeData = {
      nodes: spec.nodes,
      pointBudget: { class: 31, spec: 30, hero: 10 },
      heroSubtrees: {
        left: { ...spec.heroSubtrees.left, name: "Drifted Left" },
        right: { ...spec.heroSubtrees.right, name: "Drifted Right" },
      },
      heroGateNodeId: spec.heroGateNodeId,
    };

    const heroNode = spec.nodes.find(
      (nd) => nd.treeType === "hero" && !nd.alreadyGranted,
    );
    const selected = {
      [heroNode.id]: { pointsInvested: heroNode.maxRanks, entryChosen: null },
    };

    expect(() =>
      buildExportString(treeData, selected, spec.specId, classNodes),
    ).toThrow(/matches neither/);
  });
});

import { describe, test, expect } from "vitest";
import { createRequire } from "node:module";
import { buildExportString } from "./exportBuild.js";
import { collectClassNodes, parseBuildString } from "./buildString.js";

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

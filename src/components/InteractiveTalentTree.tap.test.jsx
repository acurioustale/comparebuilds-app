// @vitest-environment jsdom
/**
 * Tap-cycle reducer for the interactive calculator. TalentTree.touch.test.jsx
 * covers which handler a touch routes to; this covers what handleTap does once it
 * fires — specifically that a tap can always clear a node the mouse would refund
 * via right-click, even when the next rank can't be spent (section budget
 * exhausted, gate unmet, prereq lost). Regression for the case where a
 * partially-ranked node took the incrementRank branch — which silently no-ops —
 * and so could never reach the clear branch on touch.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import InteractiveTalentTree from "./InteractiveTalentTree.jsx";
import { useBuildsStore } from "../store/buildsStore";

const mkNode = (over) => ({
  connections: [],
  choices: null,
  alreadyGranted: false,
  maxRanks: 1,
  spentRequired: 0,
  icon: "i",
  ...over,
});

const makeTree = (classBudget) => ({
  pointBudget: { class: classBudget, spec: 10, hero: 10 },
  heroSubtrees: { left: { name: "L" }, right: { name: "R" } },
  heroGateNodeId: null,
  nodes: [
    mkNode({
      id: 1,
      type: "round",
      name: "Ranked",
      posX: 0,
      posY: 0,
      treeType: "class",
      heroSubtree: null,
      maxRanks: 2,
    }),
    mkNode({
      id: 2,
      type: "round",
      name: "Spec",
      posX: 0,
      posY: 0,
      treeType: "spec",
      heroSubtree: null,
    }),
    mkNode({
      id: 3,
      type: "round",
      name: "HeroL",
      posX: 0,
      posY: 0,
      treeType: "hero",
      heroSubtree: "L",
    }),
  ],
});

function renderWith(treeData) {
  useBuildsStore.setState({
    specId: 1,
    classId: null,
    treeData,
    interactiveNodes: { 1: { pointsInvested: 1, entryChosen: null } },
    addingBuild: false,
    editingIndex: null,
  });
  render(<InteractiveTalentTree treeData={treeData} classNodes={null} />);
}

const partialNode = () =>
  screen.getByRole("button", { name: "Ranked — selected, 1 of 2 points" });
const tap = (el) => {
  fireEvent.touchStart(el, { touches: [{ clientX: 5, clientY: 5 }] });
  vi.advanceTimersByTime(80);
  fireEvent.touchEnd(el, { changedTouches: [{ clientX: 5, clientY: 5 }] });
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("InteractiveTalentTree tap cycling", () => {
  test("tapping a partially-ranked node clears it when the next point is blocked", () => {
    // Class budget is 1 and the node already holds that 1 point, so canSpendPoint
    // refuses a second rank. The tap must wrap back to cleared, not no-op.
    renderWith(makeTree(1));
    tap(partialNode());
    expect(useBuildsStore.getState().interactiveNodes).toEqual({});
  });

  test("tapping a partially-ranked node adds a rank when the budget allows", () => {
    // Same node, but the class budget now leaves room, so the tap increments.
    renderWith(makeTree(2));
    tap(partialNode());
    expect(useBuildsStore.getState().interactiveNodes[1].pointsInvested).toBe(
      2,
    );
  });
});

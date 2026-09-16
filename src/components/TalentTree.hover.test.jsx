// @vitest-environment jsdom
/**
 * Prerequisite-chain hover vs. the hero lock.
 *
 * A panel drops its onHover the moment it becomes heroLocked, so the node under
 * the cursor can never deliver the onMouseLeave that would clear the hover —
 * and the lock overlay swallows pointer events, so nothing else can either. The
 * chain highlight is asserted through the connecting edge's stroke, which
 * TreePanel brightens for edges whose endpoints are both in the chain.
 */

import { describe, test, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TreePanel } from "./TalentTree.jsx";

afterEach(cleanup);

const CHAIN_STROKE = "#e8c96b";

const mkNode = (over) => ({
  connections: [],
  choices: null,
  alreadyGranted: false,
  maxRanks: 1,
  icon: "i",
  type: "round",
  treeType: "hero",
  heroSubtree: "left",
  ...over,
});

// Two hero nodes, the lower one depending on the upper: hovering either puts
// both in the chain, so the edge between them lights up. Connections point
// upward — a node lists its prerequisites, as the shipped class data does.
const nodes = [
  mkNode({ id: 1, name: "Upper", posX: 0, posY: 0 }),
  mkNode({ id: 2, name: "Lower", posX: 0, posY: 1, connections: [1] }),
];
const nodeById = { 1: nodes[0], 2: nodes[1] };

const renderPanel = (heroLocked) =>
  render(
    <TreePanel
      nodes={nodes}
      selectedNodes={{}}
      nodeById={nodeById}
      heroLocked={heroLocked}
      onNodeClick={() => {}}
    />,
  );

const chainEdges = (container) =>
  [...container.querySelectorAll("line")].filter(
    (l) => l.getAttribute("stroke") === CHAIN_STROKE,
  );

describe("TreePanel prereq-chain hover", () => {
  test("hovering a node lights its chain", () => {
    const { container } = renderPanel(false);
    expect(chainEdges(container)).toHaveLength(0);

    fireEvent.mouseEnter(screen.getByLabelText(/Upper/i));
    expect(chainEdges(container)).toHaveLength(1);

    fireEvent.mouseLeave(screen.getByLabelText(/Upper/i));
    expect(chainEdges(container)).toHaveLength(0);
  });

  test("locking the hero subtree clears a hover that can no longer be cleared", () => {
    // Regression: spending a point in the other hero subtree locks this panel
    // mid-hover (via the keyboard, or on touch where mouseleave is never
    // delivered at all). onHover went null, so the hovered node could not
    // report the leave, and the gold ring and brightened edges stayed drawn on
    // the locked panel until the subtree was unlocked again.
    const { container, rerender } = renderPanel(false);
    fireEvent.mouseEnter(screen.getByLabelText(/Upper/i));
    expect(chainEdges(container)).toHaveLength(1);

    rerender(
      <TreePanel
        nodes={nodes}
        selectedNodes={{}}
        nodeById={nodeById}
        heroLocked
        onNodeClick={() => {}}
      />,
    );

    expect(chainEdges(container)).toHaveLength(0);
  });

  test("unlocking starts with no hover held over from before the lock", () => {
    const { container, rerender } = renderPanel(false);
    fireEvent.mouseEnter(screen.getByLabelText(/Upper/i));

    const panel = (heroLocked) => (
      <TreePanel
        nodes={nodes}
        selectedNodes={{}}
        nodeById={nodeById}
        heroLocked={heroLocked}
        onNodeClick={() => {}}
      />
    );
    rerender(panel(true));
    rerender(panel(false));

    // The cursor is wherever it is now; the pre-lock hover must not come back.
    expect(chainEdges(container)).toHaveLength(0);
  });
});

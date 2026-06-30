// @vitest-environment jsdom
/**
 * Touch-gesture routing for the interactive tree. The mouse keeps spend on
 * left-click and refund on right-click; on touch a single short tap routes to
 * onNodeTap (which folds spend+refund into one cycling gesture), while a hold is
 * reserved for the tooltip and a moved finger is a scroll. These tests fire real
 * touch events through React and assert which handler fires — the reducer that
 * onNodeTap drives (rank cycling / choice toggling) lives in InteractiveTalentTree.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
} from "@testing-library/react";
import TalentTree from "./TalentTree.jsx";

const mkNode = (over) => ({
  connections: [],
  choices: null,
  alreadyGranted: false,
  maxRanks: 1,
  icon: "i",
  ...over,
});

const treeData = {
  heroSubtrees: { left: { name: "L" }, right: { name: "R" } },
  nodes: [
    mkNode({
      id: 1,
      type: "round",
      name: "Round",
      posX: 0,
      posY: 0,
      treeType: "class",
      heroSubtree: null,
    }),
    mkNode({
      id: 2,
      type: "choice",
      name: "Choice",
      posX: 0,
      posY: 0,
      treeType: "spec",
      heroSubtree: null,
      choices: [
        { name: "OptA", icon: "a", maxRanks: 1 },
        { name: "OptB", icon: "b", maxRanks: 1 },
      ],
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
    mkNode({
      id: 4,
      type: "round",
      name: "HeroR",
      posX: 0,
      posY: 0,
      treeType: "hero",
      heroSubtree: "R",
    }),
  ],
};

function renderTree() {
  const onNodeClick = vi.fn();
  const onNodeContextMenu = vi.fn();
  const onNodeTap = vi.fn();
  render(
    <TalentTree
      treeData={treeData}
      selectedNodes={{}}
      onNodeClick={onNodeClick}
      onNodeContextMenu={onNodeContextMenu}
      onNodeTap={onNodeTap}
    />,
  );
  return { onNodeClick, onNodeContextMenu, onNodeTap };
}

const round = () =>
  screen.getByRole("button", { name: "Round — not selected" });
const startAt = (el, x = 5, y = 5) =>
  fireEvent.touchStart(el, { touches: [{ clientX: x, clientY: y }] });
const moveTo = (el, x, y) =>
  fireEvent.touchMove(el, { touches: [{ clientX: x, clientY: y }] });
const end = (el) =>
  fireEvent.touchEnd(el, { changedTouches: [{ clientX: 5, clientY: 5 }] });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("TalentTree touch gestures", () => {
  test("a short tap routes to onNodeTap, not the mouse spend handler", () => {
    const { onNodeTap, onNodeClick } = renderTree();
    const el = round();
    startAt(el);
    vi.advanceTimersByTime(80);
    end(el);
    expect(onNodeTap).toHaveBeenCalledTimes(1);
    expect(onNodeTap).toHaveBeenCalledWith(1);
    expect(onNodeClick).not.toHaveBeenCalled();
  });

  test("a hold past the tooltip threshold is a peek, not a tap", () => {
    const { onNodeTap } = renderTree();
    const el = round();
    startAt(el);
    act(() => {
      vi.advanceTimersByTime(400); // ≥ TAP_HOLD_MS — the tooltip peeks instead
    });
    end(el);
    expect(onNodeTap).not.toHaveBeenCalled();
  });

  test("a moved finger is a scroll and cancels the tap", () => {
    const { onNodeTap } = renderTree();
    const el = round();
    startAt(el, 5, 5);
    moveTo(el, 60, 60); // past TAP_MOVE_TOL
    vi.advanceTimersByTime(80);
    end(el);
    expect(onNodeTap).not.toHaveBeenCalled();
  });

  test("a choice option taps with its option index", () => {
    const { onNodeTap } = renderTree();
    const optB = screen.getByRole("button", { name: "OptB" });
    startAt(optB);
    vi.advanceTimersByTime(80);
    end(optB);
    expect(onNodeTap).toHaveBeenCalledWith(2, 1);
  });

  test("desktop click still routes to the mouse spend handler (no regression)", () => {
    const { onNodeClick, onNodeTap } = renderTree();
    fireEvent.click(round());
    expect(onNodeClick).toHaveBeenCalledWith(1);
    expect(onNodeTap).not.toHaveBeenCalled();
  });
});

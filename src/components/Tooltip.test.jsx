// @vitest-environment jsdom
/**
 * Tooltip child-coercion tests. Floating UI needs a single element to anchor to;
 * these verify a valid element passes through and a non-element child (string,
 * number, array, nullish) is wrapped rather than crashing at children.props.
 */

import { describe, test, expect, afterEach, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  act,
} from "@testing-library/react";
import Tooltip from "./Tooltip.jsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Tooltip child handling", () => {
  test("renders a valid element child without wrapping it", () => {
    render(
      <Tooltip content="tip">
        <button>Click me</button>
      </Tooltip>,
    );
    const btn = screen.getByRole("button", { name: "Click me" });
    expect(btn.tagName).toBe("BUTTON");
  });

  test("wraps a bare string child instead of throwing", () => {
    expect(() =>
      render(<Tooltip content="tip">just text</Tooltip>),
    ).not.toThrow();
    expect(screen.getByText("just text").tagName).toBe("SPAN");
  });

  test("wraps a multi-child array instead of throwing", () => {
    expect(() =>
      render(
        <Tooltip content="tip">
          {["a", "b"]}
          {" and more"}
        </Tooltip>,
      ),
    ).not.toThrow();
  });
});

describe("Tooltip hold gesture", () => {
  const touch = (x, y) => ({ clientX: x, clientY: y });

  /** Renders a hold-mode tooltip and returns its anchor element. */
  function renderHold() {
    render(
      <Tooltip content="tip" touch="hold">
        <button>Talent</button>
      </Tooltip>,
    );
    return screen.getByRole("button", { name: "Talent" });
  }

  test("a two-finger tap leaves no timer that opens the tooltip", () => {
    // Regression: onTouchStart overwrote holdTimer.current without clearing it,
    // so a second touchpoint orphaned the first timer. Nothing else held it, so
    // neither touchend nor the unmount cleanup could reach it, and it fired
    // setOpen(true) with no finger down — the tooltip popped open over the tree
    // and stayed until an unrelated outside press dismissed it.
    vi.useFakeTimers();
    const btn = renderHold();

    // Two fingers land on the same node, then both lift well inside the hold
    // threshold — an accidental two-finger tap, or the start of a pinch-zoom.
    fireEvent.touchStart(btn, { touches: [touch(10, 10)] });
    fireEvent.touchStart(btn, { touches: [touch(12, 12)] });
    fireEvent.touchEnd(btn, { touches: [] });
    fireEvent.touchEnd(btn, { touches: [] });

    act(() => vi.advanceTimersByTime(1000));

    expect(screen.queryByText("tip")).not.toBeInTheDocument();
  });

  test("a second finger's lift does not close a tooltip being held", () => {
    // Regression: the hold handlers were not scoped to the finger doing the
    // holding, so ANY touchend closed the peek. Tapping the screen with a
    // second finger while still pressing a talent dismissed the tooltip the
    // user was reading.
    vi.useFakeTimers();
    const btn = renderHold();

    // Finger A presses and holds until the peek opens.
    fireEvent.touchStart(btn, {
      touches: [{ identifier: 1, ...touch(10, 10) }],
      targetTouches: [{ identifier: 1, ...touch(10, 10) }],
    });
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByText("tip")).toBeInTheDocument();

    // Finger B taps the same node and lifts. A is still down.
    fireEvent.touchStart(btn, {
      touches: [
        { identifier: 1, ...touch(10, 10) },
        { identifier: 2, ...touch(14, 14) },
      ],
      targetTouches: [
        { identifier: 1, ...touch(10, 10) },
        { identifier: 2, ...touch(14, 14) },
      ],
    });
    fireEvent.touchEnd(btn, {
      changedTouches: [{ identifier: 2, ...touch(14, 14) }],
      touches: [{ identifier: 1, ...touch(10, 10) }],
    });

    expect(screen.getByText("tip")).toBeInTheDocument();

    // Lifting A — the finger that owns the hold — does close it.
    fireEvent.touchEnd(btn, {
      changedTouches: [{ identifier: 1, ...touch(10, 10) }],
      touches: [],
    });
    expect(screen.queryByText("tip")).not.toBeInTheDocument();
  });

  test("a second finger does not push back a pending peek", () => {
    // The timer used to be restarted from e.touches[0] — the FIRST finger's
    // position — so a second touchpoint delayed the peek by another HOLD_MS.
    vi.useFakeTimers();
    const btn = renderHold();

    fireEvent.touchStart(btn, {
      touches: [{ identifier: 1, ...touch(10, 10) }],
      targetTouches: [{ identifier: 1, ...touch(10, 10) }],
    });
    act(() => vi.advanceTimersByTime(300)); // not yet open

    fireEvent.touchStart(btn, {
      touches: [
        { identifier: 1, ...touch(10, 10) },
        { identifier: 2, ...touch(14, 14) },
      ],
      targetTouches: [
        { identifier: 1, ...touch(10, 10) },
        { identifier: 2, ...touch(14, 14) },
      ],
    });
    act(() => vi.advanceTimersByTime(100)); // past HOLD_MS for the ORIGINAL press

    expect(screen.getByText("tip")).toBeInTheDocument();
  });

  test("another finger's movement does not cancel the hold", () => {
    vi.useFakeTimers();
    const btn = renderHold();

    fireEvent.touchStart(btn, {
      touches: [{ identifier: 1, ...touch(10, 10) }],
      targetTouches: [{ identifier: 1, ...touch(10, 10) }],
    });
    // A second finger swipes far away; the holding finger has barely moved.
    fireEvent.touchMove(btn, {
      touches: [
        { identifier: 2, ...touch(400, 400) },
        { identifier: 1, ...touch(11, 11) },
      ],
    });
    act(() => vi.advanceTimersByTime(400));

    expect(screen.getByText("tip")).toBeInTheDocument();
  });

  test("a single sustained hold still opens the tooltip", () => {
    vi.useFakeTimers();
    const btn = renderHold();

    fireEvent.touchStart(btn, { touches: [touch(10, 10)] });
    act(() => vi.advanceTimersByTime(400));

    expect(screen.getByText("tip")).toBeInTheDocument();
  });
});

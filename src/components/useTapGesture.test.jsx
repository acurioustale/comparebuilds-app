// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTapGesture } from "./useTapGesture";

const touch = (x, y) => ({ touches: [{ clientX: x, clientY: y }] });

describe("useTapGesture", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("swallows the synthetic click that immediately follows a tap", () => {
    const { result } = renderHook(() => useTapGesture());
    const onTap = vi.fn();
    const handlers = result.current.makeTouchHandlers(onTap);

    handlers.onTouchStart(touch(0, 0));
    handlers.onTouchEnd();
    expect(onTap).toHaveBeenCalledTimes(1);

    const click = vi.fn();
    result.current.guardClick(click)();
    expect(click).not.toHaveBeenCalled();
  });

  it("does not swallow a genuine click once the synthetic-click window has elapsed", () => {
    // Models a tap whose synthetic click never arrived (e.g. the node
    // re-rendered on the tap), leaving the flag set. A later genuine click must
    // not be consumed by the stale flag.
    const { result } = renderHook(() => useTapGesture());
    const handlers = result.current.makeTouchHandlers(vi.fn());

    handlers.onTouchStart(touch(0, 0));
    handlers.onTouchEnd();
    vi.advanceTimersByTime(1000);

    const click = vi.fn();
    result.current.guardClick(click)();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("does not swallow clicks when there was no preceding tap (mouse only)", () => {
    const { result } = renderHook(() => useTapGesture());
    const click = vi.fn();
    result.current.guardClick(click)();
    expect(click).toHaveBeenCalledTimes(1);
  });

  const evt = (firesTouchEvents) => ({
    nativeEvent: { sourceCapabilities: { firesTouchEvents } },
  });

  it("swallows a touch-fired click within the window (Chromium capability)", () => {
    const { result } = renderHook(() => useTapGesture());
    const handlers = result.current.makeTouchHandlers(vi.fn());
    handlers.onTouchStart(touch(0, 0));
    handlers.onTouchEnd();

    const click = vi.fn();
    result.current.guardClick(click)(evt(true));
    expect(click).not.toHaveBeenCalled();
  });

  it("does not swallow a genuine mouse click within the window on a hybrid device", () => {
    // The tap's own synthetic click was dropped (re-render), so the flag is
    // still set and we're within SYNTHETIC_CLICK_MS. A real mouse click reports
    // firesTouchEvents=false and must reach the handler, not be lost.
    const { result } = renderHook(() => useTapGesture());
    const handlers = result.current.makeTouchHandlers(vi.fn());
    handlers.onTouchStart(touch(0, 0));
    handlers.onTouchEnd();

    const click = vi.fn();
    result.current.guardClick(click)(evt(false));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("a second finger does not restart the in-progress gesture", () => {
    // Regression: onTouchStart unconditionally overwrote tapStart, so a later
    // touchpoint replaced the held gesture's start time. Lifting the FIRST
    // finger then read as a fresh short tap and fired onTap — spending (or, at
    // max ranks, refunding) a point the user never asked for.
    const { result } = renderHook(() => useTapGesture());
    const onTap = vi.fn();
    const handlers = result.current.makeTouchHandlers(onTap);

    // Press and hold to read the tooltip.
    handlers.onTouchStart(touch(0, 0));
    vi.advanceTimersByTime(600); // well past TAP_HOLD_MS

    // A second finger taps the same node while the first is still down.
    handlers.onTouchStart({
      touches: [
        { clientX: 0, clientY: 0 },
        { clientX: 2, clientY: 2 },
      ],
    });

    // Lifting the first finger must still read as the hold it was.
    handlers.onTouchEnd();
    expect(onTap).not.toHaveBeenCalled();
  });

  it("starts a fresh gesture on the next single touch", () => {
    // The guard keys on the live touch count, not on tapStart already being
    // set, so a dropped touchend can never wedge the gesture permanently.
    const { result } = renderHook(() => useTapGesture());
    const onTap = vi.fn();
    const handlers = result.current.makeTouchHandlers(onTap);

    handlers.onTouchStart(touch(0, 0));
    handlers.onTouchStart({
      touches: [
        { clientX: 0, clientY: 0 },
        { clientX: 2, clientY: 2 },
      ],
    });
    // No touchend arrives for either finger.

    handlers.onTouchStart(touch(5, 5));
    handlers.onTouchEnd();
    expect(onTap).toHaveBeenCalledTimes(1);
  });
});

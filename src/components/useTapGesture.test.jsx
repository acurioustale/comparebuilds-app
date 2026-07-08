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
});

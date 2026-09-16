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

  it("taps normally while another finger rests elsewhere on the screen", () => {
    // Regression: the guard read e.touches, which counts every touch on the
    // DOCUMENT. A thumb resting on the screen while holding the phone made
    // every talent tap a silent no-op — no point spent, no refund, no feedback.
    // Scoping to targetTouches is what the comment always described.
    const { result } = renderHook(() => useTapGesture());
    const onTap = vi.fn();
    const handlers = result.current.makeTouchHandlers(onTap);

    handlers.onTouchStart({
      // Two fingers down on the page, but only one of them on this node.
      touches: [
        { identifier: 1, clientX: 300, clientY: 700 },
        { identifier: 2, clientX: 40, clientY: 40 },
      ],
      targetTouches: [{ identifier: 2, clientX: 40, clientY: 40 }],
    });
    handlers.onTouchEnd({
      changedTouches: [{ identifier: 2, clientX: 40, clientY: 40 }],
    });

    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it("a second finger lifting does not consume the first finger's gesture", () => {
    // Regression: onTouchEnd took no event and so could not tell which finger
    // lifted. A second finger landing and lifting on the same node within
    // TAP_HOLD_MS fired the FIRST finger's pending tap, spending (or, at max
    // ranks, clearing) a point the user never asked for. The older two-finger
    // test only covers the ≥ TAP_HOLD_MS hold, where the hold check masks this.
    const { result } = renderHook(() => useTapGesture());
    const onTap = vi.fn();
    const handlers = result.current.makeTouchHandlers(onTap);

    // Finger A lands on the node.
    handlers.onTouchStart({
      touches: [{ identifier: 1, clientX: 40, clientY: 40 }],
      targetTouches: [{ identifier: 1, clientX: 40, clientY: 40 }],
    });
    vi.advanceTimersByTime(50); // still well inside the tap window

    // Finger B lands on the same node and lifts again.
    handlers.onTouchStart({
      touches: [
        { identifier: 1, clientX: 40, clientY: 40 },
        { identifier: 2, clientX: 44, clientY: 44 },
      ],
      targetTouches: [
        { identifier: 1, clientX: 40, clientY: 40 },
        { identifier: 2, clientX: 44, clientY: 44 },
      ],
    });
    handlers.onTouchEnd({
      changedTouches: [{ identifier: 2, clientX: 44, clientY: 44 }],
    });

    expect(onTap).not.toHaveBeenCalled();

    // Finger A's own lift is still the gesture that counts.
    handlers.onTouchEnd({
      changedTouches: [{ identifier: 1, clientX: 40, clientY: 40 }],
    });
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it("tracks the gesture's own finger for the scroll check", () => {
    // A second finger swiping away must not mark THIS press as moved (which
    // would silently cancel a legitimate tap).
    const { result } = renderHook(() => useTapGesture());
    const onTap = vi.fn();
    const handlers = result.current.makeTouchHandlers(onTap);

    handlers.onTouchStart({
      touches: [{ identifier: 1, clientX: 40, clientY: 40 }],
      targetTouches: [{ identifier: 1, clientX: 40, clientY: 40 }],
    });
    handlers.onTouchMove({
      touches: [
        { identifier: 2, clientX: 400, clientY: 400 },
        { identifier: 1, clientX: 41, clientY: 41 },
      ],
    });
    handlers.onTouchEnd({
      changedTouches: [{ identifier: 1, clientX: 41, clientY: 41 }],
    });

    expect(onTap).toHaveBeenCalledTimes(1);
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

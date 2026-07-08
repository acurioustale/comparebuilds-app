import { useRef } from "react";

// Touch gesture thresholds (interactive tree). A press held ≥ TAP_HOLD_MS is a
// tooltip peek (the Tooltip shows it) rather than a tap; a tap moved more than
// TAP_MOVE_TOL px is a scroll, not a tap.
const TAP_HOLD_MS = 350;
const TAP_MOVE_TOL = 10;
// A tap emits a synthetic click shortly after touchend; guardClick swallows it
// within this window. Past it, the flag is treated as stale so a later genuine
// mouse click (e.g. on a hybrid device, after a synthetic click was suppressed
// by a re-render) is never consumed.
const SYNTHETIC_CLICK_MS = 700;

export function useTapGesture() {
  const tapStart = useRef(null);
  const tapFired = useRef(false);
  const tapFiredAt = useRef(0);

  const makeTouchHandlers = (onTap) =>
    onTap
      ? {
          onTouchStart: (e) => {
            tapFired.current = false;
            const t = e.touches[0];
            tapStart.current = {
              time: Date.now(),
              x: t.clientX,
              y: t.clientY,
              moved: false,
            };
          },
          onTouchMove: (e) => {
            const s = tapStart.current;
            if (!s) return;
            const t = e.touches[0];
            if (
              Math.abs(t.clientX - s.x) > TAP_MOVE_TOL ||
              Math.abs(t.clientY - s.y) > TAP_MOVE_TOL
            ) {
              s.moved = true;
            }
          },
          onTouchEnd: () => {
            const s = tapStart.current;
            tapStart.current = null;
            // A scroll (moved) or a hold (a tooltip peek, not a tap) does nothing.
            if (!s || s.moved || Date.now() - s.time >= TAP_HOLD_MS) return;
            tapFired.current = true;
            tapFiredAt.current = Date.now();
            onTap();
          },
          onTouchCancel: () => {
            tapStart.current = null;
          },
        }
      : null;

  // Wraps a click handler so the synthetic post-tap click is ignored on touch.
  // When the click carries InputDeviceCapabilities (Chromium), that tells us
  // definitively whether it was fired by touch (the synthetic post-tap click, to
  // swallow) or by a real mouse (to let through) — so on a hybrid device a
  // genuine mouse click landing within the window of a tap whose synthetic click
  // was dropped by a re-render is not lost. Where the capability is unavailable
  // (e.g. Firefox, or a synthetic call with no event) fall back to the time
  // window; a stale flag still expires past it so it can't swallow a later click.
  const guardClick =
    (fn) =>
    (...args) => {
      if (tapFired.current) {
        tapFired.current = false;
        const firesTouch =
          args[0]?.nativeEvent?.sourceCapabilities?.firesTouchEvents;
        if (firesTouch === true) return; // the synthetic touch click — swallow it
        if (firesTouch === false) {
          // A real mouse click — never the synthetic one, so let it through.
        } else if (Date.now() - tapFiredAt.current < SYNTHETIC_CLICK_MS) {
          return;
        }
      }
      fn(...args);
    };

  return { makeTouchHandlers, guardClick };
}

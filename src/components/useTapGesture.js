import { useRef } from "react";

// Touch gesture thresholds (interactive tree). A press held ≥ TAP_HOLD_MS is a
// tooltip peek (the Tooltip shows it) rather than a tap; a tap moved more than
// TAP_MOVE_TOL px is a scroll, not a tap.
const TAP_HOLD_MS = 350;
const TAP_MOVE_TOL = 10;

export function useTapGesture() {
  const tapStart = useRef(null);
  const tapFired = useRef(false);

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
            onTap();
          },
          onTouchCancel: () => {
            tapStart.current = null;
          },
        }
      : null;

  // Wraps a click handler so the synthetic post-tap click is ignored on touch.
  const guardClick =
    (fn) =>
    (...args) => {
      if (tapFired.current) {
        tapFired.current = false;
        return;
      }
      fn(...args);
    };

  return { makeTouchHandlers, guardClick };
}

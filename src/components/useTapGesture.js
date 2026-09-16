import { useRef } from "react";
import { ownTouchLifted, ownTouches, touchById } from "../lib/touchIdentity";

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
            // Only the first finger down ON THIS NODE starts a gesture. A later
            // touchpoint landing on the same node would otherwise overwrite
            // tapStart, and the FIRST touchend to fire would then evaluate the
            // hold check against the wrong start time: press and hold a node to
            // read its tooltip, tap it with a second finger, and lifting the
            // first finger looks like a fresh short tap — firing onTap and
            // spending (or, at max ranks, refunding) a point the user never
            // asked for. Scoped to targetTouches, not touches: the latter counts
            // every touch on the document, so a finger resting anywhere on
            // screen (the thumb holding the phone, a tooltip held open on
            // another talent) would make every tap here a silent no-op. Keyed on
            // the live touch count rather than "tapStart is already set" so a
            // dropped touchend can't wedge the gesture permanently. (A real
            // touchstart always lists the started finger in targetTouches — its
            // target IS this element — so an empty list means a synthetic event
            // that didn't populate one, and we fall back rather than drop the
            // gesture.)
            const own = ownTouches(e);
            if (own.length > 1) return;
            tapFired.current = false;
            const t = own[0];
            tapStart.current = {
              id: t.identifier,
              time: Date.now(),
              x: t.clientX,
              y: t.clientY,
              moved: false,
            };
          },
          onTouchMove: (e) => {
            const s = tapStart.current;
            if (!s) return;
            // Follow the gesture's own finger; another finger's movement says
            // nothing about whether THIS press turned into a scroll.
            const t = touchById(e.touches, s.id) ?? e.touches[0];
            if (!t) return;
            if (
              Math.abs(t.clientX - s.x) > TAP_MOVE_TOL ||
              Math.abs(t.clientY - s.y) > TAP_MOVE_TOL
            ) {
              s.moved = true;
            }
          },
          onTouchEnd: (e) => {
            const s = tapStart.current;
            if (!s) return;
            // changedTouches holds exactly the fingers this event lifted. If the
            // gesture's own finger isn't among them, some other finger lifted —
            // leave the gesture pending rather than consuming it, or a second
            // finger touching down and lifting on the same node would fire the
            // first finger's tap and spend a point unasked.
            if (!ownTouchLifted(e, s)) return;
            tapStart.current = null;
            // A scroll (moved) or a hold (a tooltip peek, not a tap) does nothing.
            if (s.moved || Date.now() - s.time >= TAP_HOLD_MS) return;
            tapFired.current = true;
            tapFiredAt.current = Date.now();
            onTap();
          },
          onTouchCancel: (e) => {
            if (!ownTouchLifted(e, tapStart.current)) return;
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

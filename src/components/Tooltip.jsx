import { useRef, useState, useEffect, cloneElement } from "react";
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  arrow,
  useHover,
  useFocus,
  useClick,
  useDismiss,
  useRole,
  useInteractions,
  useMergeRefs,
  FloatingPortal,
  FloatingArrow,
} from "@floating-ui/react";

// Themed tooltip wrapper over Floating UI, replacing @tippyjs/react. Floating UI
// is headless: it owns positioning (flip/shift/offset/arrow) and the interaction
// hooks; this component is the one place that wires them to the app's look and
// gesture model, so the ~dozen call sites stay a one-for-one swap for <Tippy>.
//
// Touch model (the reason Tippy didn't fit React 19 cleanly enough to keep):
//   - "tap"  — read-only views: a tap toggles the tooltip (mouse still uses hover).
//   - "hold" — the interactive tree: a long press peeks the tooltip while a quick
//              tap is left free to spend a point. Composes with the child's own
//              touch handlers rather than fighting them.

const HOLD_MS = 350; // matches TalentTree's tap/hold threshold
const MOVE_TOL = 10; // a drag past this many px is a scroll, not a hold
const ARROW_H = 6;

// Run an existing handler and ours back to back, so the child keeps its own
// onTouch* behaviour when "hold" mode layers a peek gesture on top.
/**
 * @param {function|null} a First event handler
 * @param {function|null} b Second event handler
 * @returns {function} Composed event handler
 */
function compose(a, b) {
  if (!a) return b;
  if (!b) return a;
  return (...args) => {
    a(...args);
    b(...args);
  };
}

/**
 * @param {object} props
 * @param {import("react").ReactNode} props.content Tooltip content
 * @param {function} [props.renderContent] Optional render function for content
 * @param {string} [props.placement="top"] Tooltip placement
 * @param {number} [props.delay=0] Hover delay in ms
 * @param {string} [props.touch="tap"] Touch interaction mode ('tap'|'hold')
 * @param {import("react").ReactElement} props.children Target element
 * @returns {import("react").JSX.Element}
 */
export default function Tooltip({
  content,
  renderContent,
  placement = "top",
  delay = 0,
  touch = "tap",
  children,
}) {
  const [open, setOpen] = useState(false);
  const arrowRef = useRef(null);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    middleware: [
      offset(ARROW_H + 2),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      arrow({ element: arrowRef }),
    ],
    whileElementsMounted: autoUpdate,
  });

  const hover = useHover(context, {
    delay: { open: delay, close: 0 },
    mouseOnly: true, // touch is handled by useClick ("tap") or the hold gesture
  });
  const focus = useFocus(context);
  // Touch tap toggles the tooltip; ignoreMouse leaves desktop clicks alone so a
  // node's real click handler (e.g. spend a point) isn't shadowed by the tooltip.
  const click = useClick(context, {
    enabled: touch === "tap",
    ignoreMouse: true,
  });
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "tooltip" });

  const { getReferenceProps, getFloatingProps } = useInteractions([
    hover,
    focus,
    click,
    dismiss,
    role,
  ]);

  // React 19 keeps a child's ref in props.ref; reading children.ref directly is
  // the deprecated access this migration exists to remove.
  const ref = useMergeRefs([refs.setReference, children.props.ref]);

  // Long-press peek for the interactive tree. A tap (released before HOLD_MS) or
  // a drag (moved past MOVE_TOL) cancels it, leaving the tap free to spend.
  const holdTimer = useRef(null);
  const holdAt = useRef(null);
  // Clear a pending hold on unmount so the timer can't fire setOpen on a node
  // that was removed mid-press (spec switch, build removal, tree collapse).
  useEffect(() => () => clearTimeout(holdTimer.current), []);
  const holdProps =
    touch === "hold"
      ? {
          onTouchStart: (e) => {
            const t = e.touches[0];
            holdAt.current = { x: t.clientX, y: t.clientY };
            holdTimer.current = setTimeout(() => setOpen(true), HOLD_MS);
          },
          onTouchMove: (e) => {
            const s = holdAt.current;
            if (!s) return;
            const t = e.touches[0];
            if (
              Math.abs(t.clientX - s.x) > MOVE_TOL ||
              Math.abs(t.clientY - s.y) > MOVE_TOL
            ) {
              clearTimeout(holdTimer.current);
            }
          },
          onTouchEnd: () => {
            clearTimeout(holdTimer.current);
            setOpen(false);
          },
          onTouchCancel: () => {
            clearTimeout(holdTimer.current);
            setOpen(false);
          },
        }
      : null;

  // Spread the child's own props first, then the composed ref, so the merged
  // reference ref wins. React 19 keeps a child's ref in props.ref, so ordering
  // ref last is what stops a ref'd child from clobbering refs.setReference and
  // leaving the tooltip with no element to position against.
  const userProps = { ...children.props, ref };
  if (holdProps) {
    for (const key of Object.keys(holdProps)) {
      userProps[key] = compose(children.props[key], holdProps[key]);
    }
  }

  return (
    <>
      {cloneElement(children, getReferenceProps(userProps))}
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className="wow-tooltip"
            {...getFloatingProps()}
          >
            {renderContent ? renderContent() : content}
            <FloatingArrow
              ref={arrowRef}
              context={context}
              fill="var(--wow-tooltip-bg)"
              stroke="var(--wow-border)"
              strokeWidth={1}
            />
          </div>
        </FloatingPortal>
      )}
    </>
  );
}

import { memo, useContext } from "react";
import Tooltip from "./Tooltip";
import NodeIcon from "./NodeIcon";
import { useNodeEmphasis, SpotlightContext } from "./SearchContext";
import {
  CHOICE_ICON,
  CHOICE_GAP,
  choiceRowWidth,
  iconGeometry,
} from "./treeLayout";
import { useTapGesture } from "./useTapGesture";

// Hover highlight for a node's prerequisite chain.
const CHAIN_RING =
  "0 0 0 2px rgba(232,201,107,0.9), 0 0 10px rgba(232,201,107,0.45)";

// Box-shadow strings for diff highlight glows
const HL_SHADOW = {
  "a-only":
    "0 0 0 2px rgba(255,68,68,0.85), 0 0 12px rgba(255,68,68,0.6), 0 0 28px rgba(255,68,68,0.3)",
  "b-only":
    "0 0 0 2px rgba(68,136,255,0.85), 0 0 12px rgba(68,136,255,0.6), 0 0 28px rgba(68,136,255,0.3)",
  diff: "0 0 0 2px rgba(245,158,11,0.9),  0 0 12px rgba(245,158,11,0.7), 0 0 28px rgba(245,158,11,0.4)",
};
const GOLD_GLOW =
  "0 0 8px rgba(200,168,75,0.55), inset 0 0 6px rgba(200,168,75,0.12)";
const INVALID_GLOW =
  "0 0 0 2px rgba(200,50,50,0.9), 0 0 12px rgba(200,50,50,0.5)";

function nodeShadow(isSelected, highlight, invalid) {
  const parts = [];
  if (isSelected) parts.push(invalid ? INVALID_GLOW : GOLD_GLOW);
  if (highlight) parts.push(HL_SHADOW[highlight]);
  return parts.length ? parts.join(", ") : undefined;
}

// ─── Tooltip content ──────────────────────────────────────────────────────────

function NodeTooltip({ node, entryChosen, pointsInvested = 0 }) {
  if (node.type === "choice") {
    return (
      <div className="space-y-2 py-0.5" style={{ maxWidth: 260 }}>
        {node.choices.map((ch, i) => (
          <div
            key={i}
            style={{
              opacity:
                entryChosen === null ? 0.85 : entryChosen === i ? 1 : 0.4,
            }}
          >
            <p className="font-semibold text-xs text-wow-gold">{ch.name}</p>
            {ch.description && (
              <p
                className="text-xs text-wow-muted mt-0.5 leading-snug"
                dangerouslySetInnerHTML={{ __html: ch.description }}
              />
            )}
          </div>
        ))}
      </div>
    );
  }

  if (node.type === "apex") {
    let cumulative = 0;
    return (
      <div className="py-0.5" style={{ maxWidth: 280 }}>
        <p className="font-semibold text-xs text-wow-gold mb-1">{node.name}</p>
        {node.ranks?.map((rank, i) => {
          const thisStart = cumulative;
          cumulative += rank.maxRanks;
          const reached = (pointsInvested ?? 0) >= cumulative;
          const inProgress = !reached && (pointsInvested ?? 0) > thisStart;
          return (
            <div
              key={i}
              className="mt-1.5"
              style={{ opacity: reached || inProgress ? 1 : 0.4 }}
            >
              {node.levels?.[i] != null && (
                <p className="text-[10px] text-wow-dim mb-0.5">
                  Level {node.levels[i]}
                </p>
              )}
              {rank.description && (
                <p
                  className="text-xs text-wow-muted leading-snug"
                  dangerouslySetInnerHTML={{ __html: rank.description }}
                />
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="py-0.5" style={{ maxWidth: 260 }}>
      <p className="font-semibold text-xs text-wow-gold">{node.name}</p>
      {node.description && (
        <p
          className="text-xs text-wow-muted mt-0.5 leading-snug"
          dangerouslySetInnerHTML={{ __html: node.description }}
        />
      )}
      {node.alreadyGranted && (
        <p className="text-xs text-wow-dim mt-1 italic">
          Passive — always active
        </p>
      )}
    </div>
  );
}

// ─── Single choice option ─────────────────────────────────────────────────────

// One option div of a choice node. Each option owns its own useTapGesture
// instance so its tap refs (tapStart/tapFired) aren't shared with its sibling —
// otherwise a tap on one option and the synthetic post-tap click on the other
// would race over a single tapFired flag, intermittently swallowing or
// double-toggling a touch selection. Hooks can't run in a loop in the parent, so
// the per-iteration component is the correct place for the hook.
function ChoiceOption({
  ch,
  index,
  nodeId,
  chosen,
  unchosen,
  isSelected,
  invalid,
  interactive,
  nodeBorder,
  nodeOpacity,
  effOpacity,
  onNodeClick,
  onNodeTap,
  makeKeyDown,
}) {
  const { makeTouchHandlers, guardClick } = useTapGesture();
  return (
    <div
      onClick={
        onNodeClick ? guardClick(() => onNodeClick(nodeId, index)) : undefined
      }
      {...makeTouchHandlers(onNodeTap ? () => onNodeTap(nodeId, index) : null)}
      className={interactive ? "tnode" : undefined}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-pressed={interactive ? chosen : undefined}
      aria-label={
        interactive ? `${ch.name}${chosen ? " — selected" : ""}` : undefined
      }
      onKeyDown={makeKeyDown(index)}
      style={{
        position: "relative",
        width: CHOICE_ICON,
        height: CHOICE_ICON,
        borderRadius: 3,
        overflow: "hidden",
        border: `1.5px solid ${chosen ? (invalid ? "rgba(200,60,60,0.85)" : "#c8a84b") : nodeBorder}`,
        opacity: effOpacity(!isSelected ? nodeOpacity : unchosen ? 0.25 : 1),
        flexShrink: 0,
        transition: "opacity 0.2s",
        zIndex: 1,
      }}
    >
      <NodeIcon icon={ch.icon} size={CHOICE_ICON} />
    </div>
  );
}

// ─── Individual talent node ───────────────────────────────────────────────────

// Memoised: a panel re-renders on every interactive spend, but a node's props
// (its sel/highlight/invalid/handlers) are referentially stable unless that
// specific node changed, so only the touched nodes actually re-render. Search and
// changes-only emphasis come through context (useNodeEmphasis), which bypasses
// memo, so those still update every node as before.
export const TalentNode = memo(function TalentNode({
  node,
  px,
  py,
  sel,
  alreadyGranted,
  highlight = null,
  locked = false,
  invalid = false,
  inChain = false,
  onHover = null,
  onNodeClick = null,
  onNodeContextMenu = null,
  onNodeTap = null,
}) {
  // `!= null` (not `!== undefined`): the store uses null as a "not-yet-parsed"
  // sentinel, and the lines below already read sel via `sel?.` — treating an
  // explicit null sel as selected would render a phantom gold/opacity-1 node with
  // 0 points.
  const isSelected = sel != null || alreadyGranted;
  const pointsInvested =
    sel?.pointsInvested ?? (alreadyGranted ? node.maxRanks : 0);
  const entryChosen = sel?.entryChosen ?? null;

  const renderTip = () => (
    <NodeTooltip
      node={node}
      entryChosen={entryChosen}
      pointsInvested={pointsInvested}
    />
  );
  const hasHandlers = onNodeClick || onNodeContextMenu;
  const onContextMenu = hasHandlers
    ? (e) => {
        e.preventDefault();
        onNodeContextMenu?.(node.id);
      }
    : undefined;

  // Touch gesture model (interactive only): a short tap cycles the node's rank
  // (unselected → +1 → … → max → cleared), folding spend and refund into one
  // unambiguous gesture. A long hold is left to the Tooltip as a tooltip peek — so
  // reading a talent no longer spends into it. Desktop is untouched: it keeps
  // click=spend, right-click=refund, hover=tooltip. `tapFired` swallows the
  // synthetic click the browser emits after a tap so it doesn't double-fire with
  // the mouse onClick path; any movement past TAP_MOVE_TOL cancels the tap (scroll).
  // This instance serves the single-icon shapes; choice options each own their own
  // instance (in ChoiceOption) so their tap refs don't race across siblings.
  const { makeTouchHandlers, guardClick } = useTapGesture();

  // Keyboard accessibility: only the interactive tree wires onNodeClick. Static
  // comparison/heatmap views stay non-focusable (their textual diff/legend is the
  // screen-reader path) so we don't add hundreds of tab stops to a read-only grid.
  const interactive = !!onNodeClick;
  const ariaLabel = alreadyGranted
    ? `${node.name} — passive, always active`
    : `${node.name} — ${pointsInvested > 0 ? "selected" : "not selected"}` +
      (node.maxRanks > 1
        ? `, ${pointsInvested} of ${node.maxRanks} points`
        : "");
  // Enter/Space spend a point; Delete/Backspace refund (keyboard analogue of
  // right-click). `entryIndex` is the choice-option index for choice nodes and
  // undefined otherwise, so the same handler serves every node shape.
  const makeKeyDown = (entryIndex) =>
    interactive
      ? (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (entryIndex == null) onNodeClick(node.id);
            else onNodeClick(node.id, entryIndex);
          } else if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            onNodeContextMenu?.(node.id);
          }
        }
      : undefined;
  const onKeyDown = makeKeyDown();

  const nodeOpacity = isSelected ? 1 : highlight ? 0.55 : locked ? 0.16 : 0.42;
  const nodeBorder = isSelected
    ? invalid
      ? "rgba(200,60,60,0.85)"
      : "#c8a84b"
    : locked
      ? "#1a1208"
      : "#2d2010";
  const nodeCursor = hasHandlers
    ? locked && !isSelected
      ? "not-allowed"
      : "pointer"
    : "default";

  // Search highlight + changes-only filter: matches/changes keep their opacity (a
  // match also gains a ring), everything else dims. In the diff a "change" is any
  // node carrying a highlight (a-only/b-only/differing). Layers on top of the
  // existing diff/invalid styling.
  const spotlightId = useContext(SpotlightContext);
  const {
    searchHit,
    effOpacity: baseEffOpacity,
    searchRing,
  } = useNodeEmphasis(node.id, highlight != null);
  const effOpacity = (base) => {
    const eff = baseEffOpacity(base);
    return spotlightId != null && spotlightId !== node.id
      ? Math.min(eff, 0.3)
      : eff;
  };
  // Appends the search-match and prereq-chain rings (when active) onto a node's
  // existing shadow, so they layer over diff/invalid styling without replacing it.
  const withSearchShadow = (shadow) => {
    const rings = [];
    if (searchRing) rings.push(searchRing);
    if (inChain && !searchHit) rings.push(CHAIN_RING);
    if (rings.length === 0) return shadow;
    return [shadow, ...rings].filter(Boolean).join(", ");
  };

  // Hover handlers report this node so the panel can light its prerequisite chain.
  const hoverProps = onHover
    ? {
        onMouseEnter: () => onHover(node.id),
        onMouseLeave: () => onHover(null),
      }
    : null;

  // ── Choice node ─────────────────────────────────────────────────────────────
  if (node.type === "choice") {
    const totalW = choiceRowWidth(node);
    return (
      <Tooltip
        renderContent={renderTip}
        placement="top"
        delay={300}
        touch={interactive ? "hold" : "tap"}
      >
        <div
          onContextMenu={onContextMenu}
          {...hoverProps}
          style={{
            position: "absolute",
            left: px - totalW / 2,
            top: py - CHOICE_ICON / 2,
            display: "flex",
            gap: CHOICE_GAP,
            cursor: nodeCursor,
            boxShadow: withSearchShadow(
              nodeShadow(isSelected, highlight, invalid),
            ),
            borderRadius: 5,
            transition: "opacity 0.2s",
          }}
        >
          {node.choices.map((ch, i) => {
            const chosen = isSelected && entryChosen === i;
            const unchosen =
              isSelected && entryChosen !== null && entryChosen !== i;
            return (
              <ChoiceOption
                key={i}
                ch={ch}
                index={i}
                nodeId={node.id}
                chosen={chosen}
                unchosen={unchosen}
                isSelected={isSelected}
                invalid={invalid}
                interactive={interactive}
                nodeBorder={nodeBorder}
                nodeOpacity={nodeOpacity}
                effOpacity={effOpacity}
                onNodeClick={onNodeClick}
                onNodeTap={onNodeTap}
                makeKeyDown={makeKeyDown}
              />
            );
          })}

          {invalid && (
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: totalW,
                height: CHOICE_ICON,
                background: "rgba(180,30,30,0.4)",
                borderRadius: 4,
                pointerEvents: "none",
                zIndex: 3,
              }}
            />
          )}
        </div>
      </Tooltip>
    );
  }

  // ── Apex / round / square node ───────────────────────────────────────────────
  // One icon-shell serves all three single-icon shapes; they differ only in icon
  // size, corner radius, and border width, which iconGeometry centralises so the
  // heatmap can't draw them differently. (Choice nodes, handled above, are the only
  // shape with two sub-icons.)
  const { size: S, radius, borderWidth } = iconGeometry(node);
  const showRank = isSelected && node.maxRanks > 1;

  return (
    <Tooltip
      renderContent={renderTip}
      placement="top"
      delay={300}
      touch={interactive ? "hold" : "tap"}
    >
      <div
        onClick={
          hasHandlers ? guardClick(() => onNodeClick?.(node.id)) : undefined
        }
        onContextMenu={onContextMenu}
        {...makeTouchHandlers(onNodeTap ? () => onNodeTap(node.id) : null)}
        {...hoverProps}
        className={interactive ? "tnode" : undefined}
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
        aria-pressed={interactive ? isSelected : undefined}
        aria-label={interactive ? ariaLabel : undefined}
        onKeyDown={onKeyDown}
        style={{
          position: "absolute",
          left: px - S / 2,
          top: py - S / 2,
          cursor: nodeCursor,
        }}
      >
        <div
          style={{
            position: "relative",
            width: S,
            height: S,
            borderRadius: radius,
            overflow: "hidden",
            border: `${borderWidth}px solid ${nodeBorder}`,
            opacity: effOpacity(nodeOpacity),
            boxShadow: withSearchShadow(
              nodeShadow(isSelected, highlight, invalid),
            ),
            transition: "opacity 0.2s",
          }}
        >
          <NodeIcon icon={node.icon} size={S} />
          {invalid && (
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: S,
                height: S,
                background: "rgba(180,30,30,0.4)",
                borderRadius: radius,
                pointerEvents: "none",
              }}
            />
          )}
        </div>

        {showRank && (
          <div
            style={{
              position: "absolute",
              bottom: -1,
              right: -1,
              fontSize: 8,
              lineHeight: 1,
              background: "rgba(0,0,0,0.92)",
              color: pointsInvested >= node.maxRanks ? "#c8a84b" : "#9a8a6a",
              padding: "1px 3px",
              borderTopLeftRadius: 3,
              fontVariantNumeric: "tabular-nums",
              fontFamily: "ui-monospace,monospace",
              pointerEvents: "none",
              zIndex: 3,
            }}
          >
            {pointsInvested}/{node.maxRanks}
          </div>
        )}
      </div>
    </Tooltip>
  );
});

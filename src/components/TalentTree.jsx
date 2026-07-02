import { useMemo, useId, useState } from "react";
import { TalentNode } from "./TalentNode";
import { activeHeroSubtree } from "../lib/spendRules";
import { spentPoints } from "../lib/treeLogic";
import { buildDependentsMap, prereqChain } from "../lib/prereqChain";
import {
  CELL,
  PAD,
  byId,
  panelBounds,
  panelEdges,
  splitSections,
  sectionRowClass,
  dividerClass,
} from "./treeLayout";

// ─── Hero locked overlay ──────────────────────────────────────────────────────

function HeroLockedOverlay() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 10,
        background: "rgba(5,4,10,0.72)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "all",
        borderRadius: 4,
      }}
    >
      <span
        style={{
          color: "#6a5a3a",
          fontSize: 10,
          fontFamily: "'FrizQuadrata', 'Palatino Linotype', serif",
          letterSpacing: "0.05em",
          textAlign: "center",
          padding: "4px 8px",
          border: "1px solid rgba(100,80,40,0.3)",
          borderRadius: 6,
          background: "rgba(0,0,0,0.4)",
          userSelect: "none",
        }}
      >
        Choose one hero talent path
      </span>
    </div>
  );
}

// ─── Gate divider ─────────────────────────────────────────────────────────────

function GateDivider({ gate, minY, W }) {
  const y = (gate.row - 0.5 - minY) * CELL + PAD;
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: y - 8,
        width: W,
        height: 16,
        display: "flex",
        alignItems: "center",
        pointerEvents: "none",
        zIndex: 5,
      }}
    >
      <div
        style={{ flex: 1, height: 1, background: "rgba(200,168,75,0.18)" }}
      />
      <span
        style={{
          padding: "2px 8px",
          background: "#0a0a12",
          border: "1px solid rgba(200,168,75,0.28)",
          borderRadius: 10,
          color: "#c8a84b",
          fontSize: 9,
          lineHeight: 1.6,
          whiteSpace: "nowrap",
          fontFamily: "'FrizQuadrata', 'Palatino Linotype', serif",
          letterSpacing: "0.04em",
        }}
      >
        {gate.points} points to unlock
      </span>
      <div
        style={{ flex: 1, height: 1, background: "rgba(200,168,75,0.18)" }}
      />
    </div>
  );
}

// ─── Tree panel ───────────────────────────────────────────────────────────────

export function TreePanel({
  nodes,
  selectedNodes,
  nodeById,
  highlights = {},
  checkpoints = [],
  invalidNodeIds = null,
  heroLocked = false,
  onNodeClick = null,
  onNodeContextMenu = null,
  onNodeTap = null,
  onClear = null,
  clearDisabled = false,
}) {
  const rawId = useId();
  const gradId = `tl-${rawId.replace(/:/g, "")}`;

  const { minX, minY, W, H } = useMemo(() => panelBounds(nodes), [nodes]);

  // A panel always holds a single section's nodes (and, for hero, a single
  // subtree), so the shared accumulator yields the panel's spent total — reused
  // so the gate-lock math can't drift from the budget/gate logic in treeLogic.
  // Pass the panel's heroSubtree too (null for class/spec) so the count stays
  // per-subtree, matching gatedPoints, even if a panel is ever handed mixed
  // hero nodes.
  const spent = useMemo(
    () =>
      spentPoints(
        nodes,
        selectedNodes,
        nodes[0]?.treeType,
        nodes[0]?.heroSubtree ?? null,
      ),
    [nodes, selectedNodes],
  );

  const unmetGates = useMemo(
    () => checkpoints.filter((g) => spent < g.points),
    [checkpoints, spent],
  );

  const lockedFromRow =
    unmetGates.length > 0
      ? Math.min(...unmetGates.map((g) => g.row))
      : Infinity;

  const edges = useMemo(
    () => panelEdges(nodes, nodeById, minX, minY),
    [nodes, nodeById, minX, minY],
  );

  // Prerequisite-chain hover: the set of node ids in the hovered node's chain
  // (itself, direct prereqs one hop above, immediate dependents below — see
  // prereqChain). Drives a gold ring on those nodes and brighter strokes on the
  // connecting edges. The dependents adjacency is precomputed once per panel so a
  // hover is a single map read rather than a full rescan of every node.
  const [hoveredId, setHoveredId] = useState(null);
  const dependentsMap = useMemo(
    () => buildDependentsMap(nodes, nodeById),
    [nodes, nodeById],
  );
  const chainIds = useMemo(
    () =>
      hoveredId == null
        ? null
        : prereqChain(hoveredId, nodeById, dependentsMap),
    [hoveredId, nodeById, dependentsMap],
  );

  return (
    <div
      className="wow-subpanel"
      style={{
        position: "relative",
        width: W,
        // Reserve a strip below the grid for the in-panel Clear so it never
        // overlaps a corner node (some class trees reach the bottom-right).
        height: onClear ? H + 24 : H,
        flexShrink: 0,
      }}
    >
      <svg
        width={W}
        height={H}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          pointerEvents: "none",
          overflow: "visible",
        }}
      >
        <defs>
          <linearGradient
            id={gradId}
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1="0"
            x2="0"
            y2={H}
          >
            <stop offset="0%" stopColor="#3a2a0a" />
            <stop offset="100%" stopColor="#c8a84b" />
          </linearGradient>
        </defs>
        {edges.map((e, i) => {
          const fromSel =
            !!selectedNodes[e.fromId] || nodeById[e.fromId]?.alreadyGranted;
          const toSel =
            !!selectedNodes[e.toId] || nodeById[e.toId]?.alreadyGranted;
          const lit = fromSel && toSel;
          const inChain = chainIds?.has(e.fromId) && chainIds?.has(e.toId);
          return (
            <line
              key={i}
              x1={e.x1}
              y1={e.y1}
              x2={e.x2}
              y2={e.y2}
              stroke={inChain ? "#e8c96b" : lit ? `url(#${gradId})` : "#2a2a2a"}
              strokeWidth={inChain ? 2.5 : lit ? 2 : 1}
            />
          );
        })}
      </svg>

      {nodes.map((node) => (
        <TalentNode
          key={node.id}
          node={node}
          px={(node.posX - minX) * CELL + PAD}
          py={(node.posY - minY) * CELL + PAD}
          sel={selectedNodes[node.id]}
          alreadyGranted={node.alreadyGranted}
          highlight={highlights[node.id] ?? null}
          locked={
            heroLocked || (!node.alreadyGranted && node.posY >= lockedFromRow)
          }
          invalid={!!invalidNodeIds?.has(node.id)}
          inChain={!!chainIds?.has(node.id)}
          onHover={heroLocked ? null : setHoveredId}
          onNodeClick={heroLocked ? null : onNodeClick}
          onNodeContextMenu={heroLocked ? null : onNodeContextMenu}
          onNodeTap={heroLocked ? null : onNodeTap}
        />
      ))}

      {unmetGates.map((gate) => (
        <GateDivider key={gate.points} gate={gate} minY={minY} W={W} />
      ))}

      {heroLocked && <HeroLockedOverlay />}

      {/* In-panel Clear, anchored to the lower-right corner. zIndex sits above the
          hero lock overlay so it stays visible (disabled) on the inactive subtree. */}
      {onClear && (
        <button
          onClick={onClear}
          disabled={clearDisabled}
          className="wow-btn text-[10px] px-2 py-0.5 rounded select-none"
          style={{ position: "absolute", right: 8, bottom: 5, zIndex: 11 }}
        >
          Clear
        </button>
      )}
    </div>
  );
}

// ─── Section label ────────────────────────────────────────────────────────────

// Counter shown inline after a section title, e.g. "12/34" (green when maxed).
function SectionCounter({ spent, max }) {
  const full = max > 0 && spent >= max;
  return (
    <span
      className={`font-mono tabular-nums text-[11px] tracking-normal ${full ? "text-green-400" : "text-wow-text"}`}
    >
      {spent}
      <span className="text-wow-muted">/{max}</span>
    </span>
  );
}

function PanelLabel({ children, spent, max }) {
  const showCounter = spent != null && max != null;
  return (
    <div className="mb-2 select-none">
      <div className="flex items-center gap-2">
        <div
          style={{
            flex: 1,
            height: 1,
            background:
              "linear-gradient(to right, transparent, rgba(200,168,75,0.55))",
          }}
        />
        <span className="text-wow-gold text-xs uppercase tracking-[0.2em] shrink-0 flex items-baseline gap-2">
          <span>{children}</span>
          {showCounter && <SectionCounter spent={spent} max={max} />}
        </span>
        <div
          style={{
            flex: 1,
            height: 1,
            background:
              "linear-gradient(to left, transparent, rgba(200,168,75,0.55))",
          }}
        />
      </div>
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export default function TalentTree({
  treeData,
  selectedNodes = {},
  highlights = {},
  invalidNodeIds = null,
  onNodeClick = null,
  onNodeContextMenu = null,
  onNodeTap = null,
  // Interactive-only: per-section spent totals and a clear handler. When present,
  // each panel header shows its counter and each panel a corner Clear button.
  // Omitted by the read-only diff/heatmap/single views.
  sectionSpent = null,
  onClearSection = null,
  // Responsive coordination: when the parent (FitToWidth) drives layout per-build,
  // it passes 'row' or 'stacked' explicitly. Left null elsewhere (interactive
  // mode), where stacking falls back to the global 2xl media query.
  layout = null,
}) {
  const nodeById = useMemo(() => byId(treeData.nodes), [treeData]);
  const budget = treeData.pointBudget;

  const { classNodes, specNodes, leftNodes, rightNodes } = useMemo(
    () => splitSections(treeData),
    [treeData],
  );

  const activeHero = useMemo(
    () => activeHeroSubtree(treeData.nodes, selectedNodes),
    [treeData.nodes, selectedNodes],
  );

  const leftLocked =
    activeHero !== null && activeHero !== treeData.heroSubtrees.left.name;
  const rightLocked =
    activeHero !== null && activeHero !== treeData.heroSubtrees.right.name;

  return (
    <div
      className="overflow-x-auto pb-1"
      style={{ display: "flex", justifyContent: "safe center" }}
    >
      <div
        style={{
          display: "inline-flex",
          flexDirection: "column",
          gap: 16,
          minWidth: "max-content",
        }}
      >
        {/* ── Class + Spec panels (stack when narrow, side by side when wide) ── */}
        <div className={sectionRowClass(layout)}>
          <div>
            <PanelLabel
              spent={sectionSpent?.class}
              max={sectionSpent ? budget?.class : undefined}
            >
              Class
            </PanelLabel>
            <TreePanel
              nodes={classNodes}
              selectedNodes={selectedNodes}
              nodeById={nodeById}
              highlights={highlights}
              checkpoints={treeData.checkpoints?.class ?? []}
              invalidNodeIds={invalidNodeIds}
              onNodeClick={onNodeClick}
              onNodeContextMenu={onNodeContextMenu}
              onNodeTap={onNodeTap}
              onClear={onClearSection ? () => onClearSection("class") : null}
              clearDisabled={!sectionSpent?.class}
            />
          </div>

          <div className={dividerClass(layout, "mt-5")} />

          <div>
            <PanelLabel
              spent={sectionSpent?.spec}
              max={sectionSpent ? budget?.spec : undefined}
            >
              Spec
            </PanelLabel>
            <TreePanel
              nodes={specNodes}
              selectedNodes={selectedNodes}
              nodeById={nodeById}
              highlights={highlights}
              checkpoints={treeData.checkpoints?.spec ?? []}
              invalidNodeIds={invalidNodeIds}
              onNodeClick={onNodeClick}
              onNodeContextMenu={onNodeContextMenu}
              onNodeTap={onNodeTap}
              onClear={onClearSection ? () => onClearSection("spec") : null}
              clearDisabled={!sectionSpent?.spec}
            />
          </div>
        </div>

        {/* ── Hero subtrees ────────────────────────────────────────────────── */}
        <div>
          {/* Section header row */}
          <div className="mb-2">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  flex: 1,
                  height: 1,
                  background:
                    "linear-gradient(to right, transparent, rgba(200,168,75,0.55))",
                }}
              />
              <span className="text-wow-gold text-xs uppercase tracking-[0.15em] select-none">
                {treeData.heroSubtrees.left.name}
              </span>
              <span
                className="text-wow-gold-dark select-none"
                style={{ fontSize: 9 }}
              >
                ✦
              </span>
              <span className="text-wow-gold text-xs uppercase tracking-[0.15em] select-none">
                {treeData.heroSubtrees.right.name}
              </span>
              {sectionSpent?.hero != null && (
                <SectionCounter
                  spent={sectionSpent.hero}
                  max={budget?.hero ?? 0}
                />
              )}
              <div
                style={{
                  flex: 1,
                  height: 1,
                  background:
                    "linear-gradient(to left, transparent, rgba(200,168,75,0.55))",
                }}
              />
            </div>
          </div>

          <div className={sectionRowClass(layout)}>
            <TreePanel
              nodes={leftNodes}
              selectedNodes={selectedNodes}
              nodeById={nodeById}
              highlights={highlights}
              invalidNodeIds={invalidNodeIds}
              heroLocked={leftLocked}
              onNodeClick={onNodeClick}
              onNodeContextMenu={onNodeContextMenu}
              onNodeTap={onNodeTap}
              onClear={onClearSection ? () => onClearSection("hero") : null}
              clearDisabled={activeHero !== treeData.heroSubtrees.left.name}
            />
            <div className={dividerClass(layout)} />
            <TreePanel
              nodes={rightNodes}
              selectedNodes={selectedNodes}
              nodeById={nodeById}
              highlights={highlights}
              invalidNodeIds={invalidNodeIds}
              heroLocked={rightLocked}
              onNodeClick={onNodeClick}
              onNodeContextMenu={onNodeContextMenu}
              onNodeTap={onNodeTap}
              onClear={onClearSection ? () => onClearSection("hero") : null}
              clearDisabled={activeHero !== treeData.heroSubtrees.right.name}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

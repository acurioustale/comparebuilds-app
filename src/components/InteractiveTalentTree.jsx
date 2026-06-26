import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Tooltip from "./Tooltip";
import TalentTree from "./TalentTree";
import { generateBuildString } from "../lib/buildString";
import { computeInvalidNodeIds, buildGrantedSeed } from "../lib/treeLogic";
import {
  sectionPoints,
  canSpendPoint,
  activeHeroSubtree,
} from "../lib/spendRules";
import { byId } from "./treeLayout";
import { useShallow } from "zustand/react/shallow";
import { useBuildsStore } from "../store/buildsStore";

// ─── Export button ────────────────────────────────────────────────────────────

function ExportButton({ onClick, state, invalidCount, hasSelection }) {
  const hasInvalid = invalidCount > 0;
  // Completeness is NOT required — partial builds (e.g. low-level twinks) are valid.
  // Only block on conflicts (unmet prereqs/gates) or an empty selection.
  const isDisabled = state !== "idle" || hasInvalid || !hasSelection;

  const label = hasInvalid
    ? "Resolve conflicts first"
    : state === "copying"
      ? "Exporting…"
      : state === "done"
        ? "Copied & added!"
        : state === "error"
          ? "Failed"
          : "Export build";

  const btn = (
    <button
      onClick={!isDisabled ? onClick : undefined}
      disabled={isDisabled}
      className="wow-btn text-xs px-3 py-1.5 rounded text-wow-text select-none disabled:opacity-30 disabled:cursor-not-allowed"
    >
      {label}
    </button>
  );

  if (hasInvalid) {
    return (
      <Tooltip
        content={`${invalidCount} node${invalidCount > 1 ? "s have" : " has"} unmet prerequisites or gate requirements. Right-click the red-flagged nodes to remove them, or re-activate the missing prerequisite.`}
        placement="bottom"
        delay={200}
      >
        <span style={{ display: "inline-block" }}>{btn}</span>
      </Tooltip>
    );
  }

  if (!hasSelection) {
    return (
      <Tooltip
        content="Spend at least one point to export."
        placement="bottom"
        delay={200}
      >
        <span style={{ display: "inline-block" }}>{btn}</span>
      </Tooltip>
    );
  }

  return btn;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function InteractiveTalentTree({
  treeData,
  classNodes,
  searchSlot = null,
}) {
  const {
    specId,
    interactiveNodes: selected,
    setInteractiveNodes,
    addBuild,
    finishAddingBuild,
  } = useBuildsStore(
    useShallow((s) => ({
      specId: s.specId,
      interactiveNodes: s.interactiveNodes,
      setInteractiveNodes: s.setInteractiveNodes,
      addBuild: s.addBuild,
      finishAddingBuild: s.finishAddingBuild,
    })),
  );
  const [exportState, setExportState] = useState("idle");
  // Holds the pending "reset after the status flashes" timer so it can be
  // cleared if the component unmounts first (avoids a state update / store
  // mutation after teardown).
  const resetTimerRef = useRef(null);
  useEffect(
    () => () => {
      if (resetTimerRef.current != null) clearTimeout(resetTimerRef.current);
    },
    [],
  );

  const budget = treeData.pointBudget;

  const nodeById = useMemo(() => byId(treeData.nodes), [treeData]);

  // ── Invalid-node detection ──────────────────────────────────────────────────

  const invalidNodeIds = useMemo(
    () => computeInvalidNodeIds(treeData.nodes, selected, nodeById),
    [treeData.nodes, selected, nodeById],
  );

  // ── Click handlers ──────────────────────────────────────────────────────────

  const handleClick = useCallback(
    (nodeId, choiceIdx = null) => {
      const node = nodeById[nodeId];
      if (!node || node.alreadyGranted) return;

      const sel = selected[nodeId];

      if (!sel) {
        if (!canSpendPoint(node, treeData.nodes, selected, nodeById, budget))
          return;
        const entryChosen = node.type === "choice" ? (choiceIdx ?? 0) : null;
        setInteractiveNodes({
          ...selected,
          [nodeId]: { pointsInvested: 1, entryChosen },
        });
      } else if (node.type === "choice") {
        const numChoices = node.choices?.length ?? 1;
        const next =
          choiceIdx !== null
            ? choiceIdx
            : ((sel.entryChosen ?? 0) + 1) % numChoices;
        if (next !== sel.entryChosen) {
          setInteractiveNodes({
            ...selected,
            [nodeId]: { ...sel, entryChosen: next },
          });
        }
      } else if (sel.pointsInvested < node.maxRanks) {
        if (!canSpendPoint(node, treeData.nodes, selected, nodeById, budget))
          return;
        setInteractiveNodes({
          ...selected,
          [nodeId]: { ...sel, pointsInvested: sel.pointsInvested + 1 },
        });
      }
    },
    [selected, nodeById, treeData.nodes, budget, setInteractiveNodes],
  );

  const handleRightClick = useCallback(
    (nodeId) => {
      const node = nodeById[nodeId];
      if (!node || node.alreadyGranted) return;
      const sel = selected[nodeId];
      if (!sel) return;

      if (node.type === "choice") {
        const next = { ...selected };
        delete next[nodeId];
        setInteractiveNodes(next);
      } else if (sel.pointsInvested > 1) {
        setInteractiveNodes({
          ...selected,
          [nodeId]: { ...sel, pointsInvested: sel.pointsInvested - 1 },
        });
      } else {
        const next = { ...selected };
        delete next[nodeId];
        setInteractiveNodes(next);
      }
    },
    [selected, nodeById, setInteractiveNodes],
  );

  // Touch tap: one gesture that cycles a node, folding spend and refund together
  // (the mouse keeps them on left/right click). For ranked nodes: +1 rank, then
  // wrap from max back to cleared. For choice nodes: tapping an option selects or
  // switches to it; tapping the already-chosen option clears the node.
  const handleTap = useCallback(
    (nodeId, choiceIdx = null) => {
      const node = nodeById[nodeId];
      if (!node || node.alreadyGranted) return;
      const sel = selected[nodeId];

      if (node.type === "choice") {
        if (!sel) {
          if (!canSpendPoint(node, treeData.nodes, selected, nodeById, budget))
            return;
          setInteractiveNodes({
            ...selected,
            [nodeId]: { pointsInvested: 1, entryChosen: choiceIdx ?? 0 },
          });
        } else if (sel.entryChosen === choiceIdx) {
          const next = { ...selected };
          delete next[nodeId];
          setInteractiveNodes(next);
        } else {
          setInteractiveNodes({
            ...selected,
            [nodeId]: { ...sel, entryChosen: choiceIdx },
          });
        }
        return;
      }

      if (!sel) {
        if (!canSpendPoint(node, treeData.nodes, selected, nodeById, budget))
          return;
        setInteractiveNodes({
          ...selected,
          [nodeId]: { pointsInvested: 1, entryChosen: null },
        });
      } else if (sel.pointsInvested < node.maxRanks) {
        if (!canSpendPoint(node, treeData.nodes, selected, nodeById, budget))
          return;
        setInteractiveNodes({
          ...selected,
          [nodeId]: { ...sel, pointsInvested: sel.pointsInvested + 1 },
        });
      } else {
        const next = { ...selected };
        delete next[nodeId];
        setInteractiveNodes(next);
      }
    },
    [selected, nodeById, treeData.nodes, budget, setInteractiveNodes],
  );

  // ── Clear handlers ──────────────────────────────────────────────────────────

  const handleClearSection = useCallback(
    (treeType) => {
      const next = { ...selected };
      for (const n of treeData.nodes) {
        if (n.treeType === treeType && !n.alreadyGranted) delete next[n.id];
      }
      setInteractiveNodes(next);
    },
    [selected, treeData.nodes, setInteractiveNodes],
  );

  const handleClearAll = useCallback(() => {
    setInteractiveNodes(buildGrantedSeed(treeData));
  }, [treeData, setInteractiveNodes]);

  // ── Point totals ────────────────────────────────────────────────────────────

  const classSpent = useMemo(
    () => sectionPoints("class", treeData.nodes, selected),
    [treeData.nodes, selected],
  );
  const specSpent = useMemo(
    () => sectionPoints("spec", treeData.nodes, selected),
    [treeData.nodes, selected],
  );
  const heroSpent = useMemo(
    () => sectionPoints("hero", treeData.nodes, selected),
    [treeData.nodes, selected],
  );

  // ── Export ──────────────────────────────────────────────────────────────────

  const handleExport = useCallback(async () => {
    if (exportState !== "idle" || !classNodes || invalidNodeIds.size > 0)
      return;
    // Allow partial builds (twink/leveling/theorycraft) — just not an empty one.
    if (classSpent === 0 && specSpent === 0 && heroSpent === 0) return;
    setExportState("copying");
    try {
      const activeSub = activeHeroSubtree(treeData.nodes, selected);
      // The hero gate node is the hero-tree choice: when hero talents are invested
      // the in-game format marks it selected with entryChosen = the active subtree
      // (0 = left, 1 = right). Include it so exports match the canonical encoding.
      const exportSelection = { ...selected };
      if (heroSpent > 0 && treeData.heroGateNodeId != null) {
        exportSelection[treeData.heroGateNodeId] = {
          pointsInvested: 1,
          entryChosen: activeSub === treeData.heroSubtrees.right.name ? 1 : 0,
        };
      }
      // Auto-granted nodes encode as selected-but-not-purchased. Class/spec grants
      // always apply; hero grants only for the active subtree (the inactive one's
      // granted root is not point-relevant and the game recomputes it on import).
      const grantedIds = new Set(
        treeData.nodes
          .filter(
            (n) =>
              n.alreadyGranted &&
              (n.treeType !== "hero" || n.heroSubtree === activeSub),
          )
          .map((n) => n.id),
      );
      const buildStr = generateBuildString(
        exportSelection,
        specId,
        classNodes,
        grantedIds,
      );
      await navigator.clipboard.writeText(buildStr);
      await addBuild(buildStr);
      setExportState("done");
      // Delay hiding the interactive tree so "Copied & added!" is briefly visible.
      resetTimerRef.current = setTimeout(() => {
        resetTimerRef.current = null;
        setExportState("idle");
        finishAddingBuild();
      }, 2000);
    } catch {
      // Keep the interactive build open on failure so the user can retry; just
      // clear the transient "Failed" status after a moment.
      setExportState("error");
      resetTimerRef.current = setTimeout(() => {
        resetTimerRef.current = null;
        setExportState("idle");
      }, 2000);
    }
  }, [
    exportState,
    selected,
    specId,
    classNodes,
    addBuild,
    invalidNodeIds.size,
    classSpent,
    specSpent,
    heroSpent,
    treeData,
    finishAddingBuild,
  ]);

  const hasUserSelection = classSpent > 0 || specSpent > 0 || heroSpent > 0;

  return (
    <div>
      {/* ── Tree ─────────────────────────────────────────────────────────────── */}
      <TalentTree
        treeData={treeData}
        selectedNodes={selected}
        invalidNodeIds={invalidNodeIds}
        onNodeClick={handleClick}
        onNodeContextMenu={handleRightClick}
        onNodeTap={handleTap}
        sectionSpent={{ class: classSpent, spec: specSpent, hero: heroSpent }}
        onClearSection={handleClearSection}
      />

      {/* ── Search (sits just above the action bar) ──────────────────────────── */}
      {searchSlot && <div className="mt-5">{searchSlot}</div>}

      {/* ── Action bar (below the trees) ─────────────────────────────────────── */}
      {/* Per-section counters live in each panel header and clears in each panel
          corner; this bar carries only the global hint and actions. */}
      <div className="mt-5 px-3 py-2.5 rounded wow-subpanel">
        <div className="flex items-center justify-between gap-6 flex-wrap">
          {/* Hint is keyed to pointer type, not screen width: the gesture set
              depends on the input device. Coarse (touch) gets the tap/hold model
              from TalentNode; everything else keeps the mouse model. */}
          <span className="text-wow-muted text-xs select-none">
            <span className="[@media(pointer:coarse)]:hidden">
              Left-click to spend · Right-click to refund
            </span>
            <span className="hidden [@media(pointer:coarse)]:inline">
              Tap to add/remove · Hold to inspect
            </span>
          </span>

          <div className="flex items-center gap-3">
            <ExportButton
              onClick={handleExport}
              state={exportState}
              invalidCount={invalidNodeIds.size}
              hasSelection={hasUserSelection}
            />
            <button
              onClick={handleClearAll}
              disabled={!hasUserSelection}
              className="wow-btn text-xs px-2.5 py-1.5 rounded select-none"
            >
              Clear All
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

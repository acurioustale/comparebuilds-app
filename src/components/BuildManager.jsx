import { useState, useCallback, memo } from "react";
import { useShallow } from "zustand/react/shallow";
import Tooltip from "./Tooltip";
import { useBuildsStore, MAX_BUILDS } from "../store/buildsStore";
import classesIndex from "../data/classes.json";
import { iconUrl, onIconError } from "../lib/iconUrl";
import { sectionPoints } from "../lib/spendRules";
import { defaultBuildLabel } from "../lib/buildLabel";
import { FilledSlot, EmptySlot } from "./BuildManagerSlots";
import { useShareActions } from "../hooks/useShareActions";

// Action-button label for a copy state. The share link has an async "Saving…"
// busy state; the synchronous simc copy passes busy === null and never hits it.
function actionLabel(status, idle, busy) {
  if (status === "copying") return busy;
  if (status === "copied") return "Copied!";
  if (status === "error") return "Failed";
  return idle;
}

// Inline label colour: green when done, red on failure, default otherwise.
function actionColor(status) {
  if (status === "copied") return "#4ade80";
  if (status === "error") return "#f87171";
  return undefined;
}

function pointSummary(parsed, treeData) {
  if (!parsed || !treeData) return null;
  const budget = treeData.pointBudget;
  // Reuse the interactive calculator's per-section tally so the two can't drift.
  const cls = sectionPoints("class", treeData.nodes, parsed.nodes);
  const spec = sectionPoints("spec", treeData.nodes, parsed.nodes);
  const hero = sectionPoints("hero", treeData.nodes, parsed.nodes);
  return `Class: ${cls}/${budget.class} · Spec: ${spec}/${budget.spec} · Hero: ${hero}/${budget.hero}`;
}

function ClassIcon({ name, size = 36 }) {
  // WoW class icons use the slug classicon_{name} with underscores removed.
  return (
    <img
      src={iconUrl("classicon_" + name.replaceAll("_", ""))}
      onError={onIconError}
      width={size}
      height={size}
      alt=""
      draggable={false}
      style={{ display: "block", borderRadius: 4, flexShrink: 0 }}
    />
  );
}

function SpecIcon({ icon, size = 24 }) {
  return (
    <img
      src={iconUrl(icon)}
      onError={onIconError}
      width={size}
      height={size}
      alt=""
      draggable={false}
      style={{ display: "block", borderRadius: 3, flexShrink: 0 }}
    />
  );
}

// ─── Class grid ───────────────────────────────────────────────────────────────

const ClassGrid = memo(function ClassGrid({
  classes,
  activeClassId,
  locked,
  onSelect,
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {classes
        .filter((c) => c.implemented)
        .map((cls) => {
          const isActive = cls.id === activeClassId;
          return (
            <Tooltip
              key={cls.id}
              content={
                locked && !isActive
                  ? "Clear builds to switch class"
                  : cls.displayName
              }
              placement="top"
              delay={400}
            >
              <button
                onClick={() => onSelect(cls.id)}
                disabled={locked && !isActive}
                aria-pressed={isActive}
                className={[
                  "wow-class-btn rounded p-0.5 transition-all outline-none focus-visible:ring-2 focus-visible:ring-wow-gold",
                  isActive
                    ? "wow-active opacity-100"
                    : locked
                      ? "opacity-25 cursor-not-allowed"
                      : "opacity-50 hover:opacity-80",
                ].join(" ")}
                style={
                  isActive ? { boxShadow: `0 0 0 2px ${cls.color}` } : undefined
                }
              >
                <ClassIcon name={cls.name} size={36} />
              </button>
            </Tooltip>
          );
        })}
    </div>
  );
});

// ─── Spec row ─────────────────────────────────────────────────────────────────

const SpecRow = memo(function SpecRow({ specs, activeSpecId, onSelect }) {
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {specs.map((spec) => {
        const isActive = spec.id === activeSpecId;
        return (
          <button
            key={spec.id}
            onClick={() => onSelect?.(spec.id)}
            disabled={!onSelect || isActive}
            className={[
              "flex items-center gap-1.5 px-2 py-1 rounded text-xs select-none transition-all outline-none",
              isActive
                ? "text-wow-gold ring-1 ring-wow-gold-dark"
                : onSelect
                  ? "text-wow-muted hover:text-wow-text cursor-pointer"
                  : "text-wow-muted cursor-default",
            ].join(" ")}
            style={
              isActive
                ? { background: "rgba(200,168,75,0.08)" }
                : { background: "rgba(255,255,255,0.03)" }
            }
          >
            <SpecIcon icon={spec.icon} size={20} />
            <span>{spec.displayName}</span>
          </button>
        );
      })}
    </div>
  );
});

// ─── Main component ───────────────────────────────────────────────────────────

export default function BuildManager() {
  const {
    buildStrings,
    buildNames,
    parsedBuilds,
    classId,
    specId,
    treeData,
    layoutHash,
    isLoading,
    error,
    addBuild,
    removeBuild,
    clearAllBuilds,
    preloadSpec,
    setBuildName,
    editBuild,
  } = useBuildsStore(
    useShallow((s) => ({
      buildStrings: s.buildStrings,
      buildNames: s.buildNames,
      parsedBuilds: s.parsedBuilds,
      classId: s.classId,
      specId: s.specId,
      treeData: s.treeData,
      layoutHash: s.layoutHash,
      isLoading: s.isLoading,
      error: s.error,
      addBuild: s.addBuild,
      removeBuild: s.removeBuild,
      clearAllBuilds: s.clearAllBuilds,
      preloadSpec: s.preloadSpec,
      setBuildName: s.setBuildName,
      editBuild: s.editBuild,
    })),
  );

  // Local class selection used before any builds are loaded
  const [localClassId, setLocalClassId] = useState(null);

  // Class that owns the loaded spec — lets a spec-page landing (which sets specId
  // but not classId) highlight the right class without locking the grid.
  const specClassId =
    specId != null
      ? (classesIndex.find((c) => c.specs.some((s) => s.id === specId))?.id ??
        null)
      : null;

  // Store classId takes precedence once builds exist; then an explicit local pick;
  // then the loaded spec's class.
  const activeClassId = classId ?? localClassId ?? specClassId;
  const activeClass = classesIndex.find((c) => c.id === activeClassId);
  const classLocked = classId !== null;

  // Human-readable spec/class names, used for labels and the share payload.
  const specDisplayName =
    activeClass?.specs.find((s) => s.id === specId)?.displayName ?? "";
  const classDisplayName = activeClass?.displayName ?? "";

  const { copyState, simcState, handleCopyLink, handleCopySimc } =
    useShareActions({
      classId,
      specId,
      buildStrings,
      buildNames,
      classDisplayName,
      specDisplayName,
      treeData,
      parsedBuilds,
      layoutHash,
    });

  // Human-readable build label: "Build N — [Hero Spec] Spec Class"
  const buildLabel = (n, parsedBuild) =>
    defaultBuildLabel({
      index: n,
      className: classDisplayName,
      specName: specDisplayName,
      treeData,
      parsedBuild,
    });

  const handleClassSelect = useCallback(
    (id) => {
      if (classLocked) return;
      setLocalClassId(id);
      // Reset spec + interactive tree when class changes in interactive mode
      if (buildStrings.length === 0) clearAllBuilds();
    },
    [classLocked, buildStrings.length, clearAllBuilds],
  );

  const handleSpecSelect = useCallback(
    (id) => {
      if (classLocked) return;
      preloadSpec(id);
    },
    [classLocked, preloadSpec],
  );

  // ── Slot layout ────────────────────────────────────────────────────────────
  const filledCount = buildStrings.length;
  const canAdd = filledCount < MAX_BUILDS;
  // Always show at least 2 slots so the intent (compare 2 builds) is obvious
  const totalSlots = Math.max(2, filledCount + (canAdd ? 1 : 0));

  // ── Action button visibility ───────────────────────────────────────────────
  // The share API requires 2–5 builds, so Copy link only appears once at least
  // two builds are loaded and ALL of them are fully parsed (no nulls, no
  // loading in progress).
  const allParsed =
    filledCount >= 2 &&
    !isLoading &&
    parsedBuilds.length === filledCount &&
    parsedBuilds.every(Boolean);

  return (
    <div className="wow-panel text-wow-text p-4 rounded space-y-4 max-w-2xl mx-auto">
      {/* ── Class grid ─────────────────────────────── */}
      <section>
        <SectionLabel>Class</SectionLabel>
        <ClassGrid
          classes={classesIndex}
          activeClassId={activeClassId}
          locked={classLocked}
          onSelect={handleClassSelect}
        />
      </section>

      {/* ── Spec row — only once a class is selected ─ */}
      {activeClass && (
        <section>
          <SectionLabel>Spec</SectionLabel>
          <SpecRow
            specs={activeClass.specs}
            activeSpecId={specId}
            onSelect={classLocked ? null : handleSpecSelect}
          />
        </section>
      )}

      {/* ── Build inputs ───────────────────────────── */}
      <section>
        <div className="flex items-baseline justify-between mb-2">
          <SectionLabel>
            Builds
            <span className="ml-1 text-wow-dim font-normal normal-case tracking-normal">
              {filledCount}/{MAX_BUILDS}
            </span>
          </SectionLabel>
          {filledCount > 0 && (
            <button
              onClick={clearAllBuilds}
              className="text-wow-muted hover:text-red-400 text-xs transition-colors"
            >
              Clear all
            </button>
          )}
        </div>

        <div className="space-y-2">
          {Array.from({ length: totalSlots }, (_, i) => {
            // Filled slot
            if (i < filledCount) {
              return (
                <FilledSlot
                  key={buildStrings[i]}
                  index={i}
                  name={buildNames[i] ?? ""}
                  label={buildLabel(i + 1, parsedBuilds[i])}
                  summary={pointSummary(parsedBuilds[i], treeData)}
                  value={buildStrings[i]}
                  parsed={parsedBuilds[i]}
                  // While tree data is fetched, every not-yet-parsed slot is
                  // pending, not failed — show "loading" for all of them (a
                  // multi-build share rehydration adds several slots at once, so
                  // gating this to the last slot flashes a false "Failed to
                  // parse" ✕ on the earlier pending ones).
                  loading={isLoading && parsedBuilds[i] === null}
                  onRemove={removeBuild}
                  onRename={setBuildName}
                  onEdit={editBuild}
                />
              );
            }

            // Empty input slot — error is only shown on the primary empty slot
            // (the one at filledCount, i.e. the first empty one)
            const isPrimary = i === filledCount;
            // Key by ordinal among the empty slots (not absolute index): the
            // primary input is always ordinal 0, so adding/removing a build
            // keeps its key stable. An index-based key would shift on remove,
            // remounting the input and discarding any unsubmitted typed text.
            return (
              <EmptySlot
                key={`empty-${i - filledCount}`}
                index={i}
                onAdd={addBuild}
                errorMsg={isPrimary ? error : null}
              />
            );
          })}
        </div>
      </section>

      {/* ── Action buttons ─────────────────────────── */}
      {allParsed && (
        <section className="flex justify-end items-center gap-2 pt-3 border-t border-wow-dim">
          <button
            type="button"
            onClick={handleCopySimc}
            className="wow-btn px-4 py-2 text-xs rounded select-none"
            style={{ color: actionColor(simcState) }}
          >
            {actionLabel(simcState, "Copy simc profileset", null)}
          </button>
          <button
            type="button"
            onClick={handleCopyLink}
            className="wow-btn px-4 py-2 text-xs rounded select-none"
            style={{ color: actionColor(copyState) }}
          >
            {actionLabel(copyState, "Share link", "Saving…")}
          </button>
        </section>
      )}
    </div>
  );
}

// ─── Tiny shared presentational bits ─────────────────────────────────────────

function SectionLabel({ children }) {
  return (
    <p className="text-wow-gold-dark text-xs uppercase tracking-widest mb-1.5">
      {children}
    </p>
  );
}

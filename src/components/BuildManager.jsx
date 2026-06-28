import { useState, useRef, useEffect, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import Tooltip from "./Tooltip";
import {
  useBuildsStore,
  MAX_BUILDS,
  MAX_BUILD_NAME_LEN,
} from "../store/buildsStore";
import { createServerShare } from "../lib/shareLink";
import classesIndex from "../data/classes.json";
import { iconUrl, onIconError } from "../lib/iconUrl";
import { activeHeroSubtree, sectionPoints } from "../lib/spendRules";
import { generateSimcProfileset } from "../lib/simcProfile";

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

function ClassGrid({ classes, activeClassId, locked, onSelect }) {
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
}

// ─── Spec row ─────────────────────────────────────────────────────────────────

function SpecRow({ specs, activeSpecId, onSelect }) {
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
}

// ─── Build slot (filled) ──────────────────────────────────────────────────────

function SlotStatus({ parsed, loading }) {
  if (loading) {
    return (
      <span className="w-16 text-right text-wow-dim text-xs animate-pulse">
        loading…
      </span>
    );
  }
  if (parsed === undefined || parsed === null) {
    return (
      <Tooltip content="Failed to parse" placement="left">
        <span className="w-4 text-center text-red-500 text-sm cursor-default select-none leading-none">
          ✕
        </span>
      </Tooltip>
    );
  }
  return (
    <span className="w-4 text-center text-green-500 text-sm select-none leading-none">
      ✓
    </span>
  );
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

function FilledSlot({
  index,
  name,
  label,
  summary,
  value,
  parsed,
  loading,
  onRemove,
  onRename,
  onEdit,
}) {
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef(null);
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setFlash(true);
      flashTimer.current = setTimeout(() => setFlash(false), 1500);
    } catch {
      // clipboard unavailable — silently ignore
    }
  }, [value]);

  return (
    <div className="flex items-center gap-2 min-w-0">
      <SlotNumber n={index + 1} />

      {/* Editable slot name. Empty shows the computed default as a placeholder. */}
      <input
        value={name}
        onChange={(e) => onRename(e.target.value)}
        placeholder={label}
        maxLength={MAX_BUILD_NAME_LEN}
        aria-label={`Name for build ${index + 1}`}
        spellCheck={false}
        className="flex-1 min-w-0 text-xs rounded px-2 py-1.5 text-wow-gold placeholder-wow-dim outline-none transition-colors"
        style={{
          background: "rgba(255,255,255,0.04)",
          border: "1px solid #3a2e1a",
        }}
        onFocus={(e) => {
          e.target.style.borderColor = "#8b6914";
        }}
        onBlur={(e) => {
          e.target.style.borderColor = "#3a2e1a";
        }}
      />

      <Tooltip
        content={flash ? "Copied!" : (summary ?? "Copy build string")}
        placement="bottom"
        delay={300}
      >
        <button
          onClick={handleCopy}
          aria-label="Copy build string"
          className="shrink-0 w-6 h-6 flex items-center justify-center transition-colors text-sm leading-none rounded"
          style={{ color: flash ? "#4ade80" : undefined }}
        >
          {flash ? "✓" : "⧉"}
        </button>
      </Tooltip>

      {parsed && (
        <Tooltip content="Edit build" placement="bottom" delay={300}>
          <button
            onClick={onEdit}
            aria-label={`Edit build ${index + 1}`}
            className="shrink-0 w-6 h-6 flex items-center justify-center text-wow-dim hover:text-wow-gold transition-colors text-sm leading-none rounded"
          >
            ✎
          </button>
        </Tooltip>
      )}

      <button
        onClick={onRemove}
        title="Remove"
        className="shrink-0 w-6 h-6 flex items-center justify-center text-wow-dim hover:text-red-400 transition-colors text-base leading-none rounded"
      >
        ×
      </button>

      <SlotStatus parsed={parsed} loading={loading} />
    </div>
  );
}

// ─── Empty slot (input) ───────────────────────────────────────────────────────

function EmptySlot({ index, onAdd, errorMsg }) {
  const [value, setValue] = useState("");
  const inputRef = useRef(null);

  const submit = useCallback(
    (text) => {
      const trimmed = text ?? value.trim();
      if (!trimmed) return;
      setValue("");
      onAdd(trimmed);
    },
    [value, onAdd],
  );

  // Auto-submit on paste so users don't need to press Enter
  const handlePaste = (e) => {
    const pasted = e.clipboardData?.getData("text/plain") ?? "";
    if (pasted.trim()) {
      e.preventDefault();
      submit(pasted.trim());
    }
  };

  // Clipboard button: read directly from OS clipboard
  const handleClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) submit(text.trim());
    } catch {
      // Permissions denied or not supported; user can paste manually
      inputRef.current?.focus();
    }
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <SlotNumber n={index + 1} muted />

        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          onPaste={handlePaste}
          placeholder="Paste build string…"
          className="flex-1 font-mono text-xs rounded px-2 py-1.5 text-wow-text placeholder-wow-dim outline-none transition-colors"
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid #3a2e1a",
          }}
          onFocus={(e) => {
            e.target.style.borderColor = "#8b6914";
          }}
          onBlur={(e) => {
            e.target.style.borderColor = "#3a2e1a";
          }}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
        />

        <button
          onClick={handleClipboard}
          title="Paste from clipboard"
          className="wow-btn shrink-0 px-2.5 py-1.5 text-xs rounded"
        >
          Paste
        </button>

        {/* Spacer aligns with the status icon column of filled slots */}
        <span className="w-4 shrink-0" />
      </div>

      {errorMsg && (
        <p className="ml-[1.375rem] text-red-400 text-xs leading-snug pl-2">
          {errorMsg}
        </p>
      )}
    </div>
  );
}

// Shared slot number label
function SlotNumber({ n, muted = false }) {
  return (
    <span
      className={[
        "shrink-0 w-4 text-right text-xs tabular-nums select-none",
        muted ? "text-wow-dim" : "text-wow-muted",
      ].join(" ")}
    >
      {n}
    </span>
  );
}

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

  const [copyState, setCopyState] = useState("idle"); // 'idle' | 'copying' | 'copied' | 'error'
  const [simcState, setSimcState] = useState("idle"); // 'idle' | 'copied' | 'error'
  // Reset timers, cleared on unmount so they can't fire setState on a removed
  // share-controls component (e.g. clearing all builds within the 2s window).
  const copyTimer = useRef(null);
  const simcTimer = useRef(null);
  useEffect(
    () => () => {
      clearTimeout(copyTimer.current);
      clearTimeout(simcTimer.current);
    },
    [],
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

  const handleCopyLink = useCallback(async () => {
    if (copyState !== "idle") return;
    setCopyState("copying");
    try {
      const labels = buildNames.some(Boolean) ? buildNames : undefined;
      const { id } = await createServerShare({
        classId,
        specId,
        builds: buildStrings,
        labels,
        className: classDisplayName,
        specName: specDisplayName,
        layoutHash,
      });
      // /s/<id> is the server-rendered share page (link previews); it redirects
      // humans to the SPA, which also opens a bare #<id> hash via the route
      // resolver. (Ids are content-addressed now, so links from before that
      // migration — old 6-char ids — no longer resolve.)
      const url = `${window.location.origin}/s/${id}`;
      await navigator.clipboard.writeText(url);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    } finally {
      copyTimer.current = setTimeout(() => setCopyState("idle"), 2000);
    }
  }, [
    copyState,
    classId,
    specId,
    buildStrings,
    buildNames,
    classDisplayName,
    specDisplayName,
    layoutHash,
  ]);

  const handleCopySimc = useCallback(async () => {
    if (simcState !== "idle") return;
    try {
      const profileset = generateSimcProfileset(
        buildStrings,
        buildNames,
        classDisplayName,
        specDisplayName,
        treeData,
        parsedBuilds,
      );
      await navigator.clipboard.writeText(profileset);
      setSimcState("copied");
    } catch {
      setSimcState("error");
    } finally {
      simcTimer.current = setTimeout(() => setSimcState("idle"), 2000);
    }
  }, [
    simcState,
    buildStrings,
    buildNames,
    classDisplayName,
    specDisplayName,
    treeData,
    parsedBuilds,
  ]);

  // Human-readable build label: "Build N — [Hero Spec] Spec Class"
  const buildLabel = (n, parsedBuild) => {
    if (!specDisplayName || !classDisplayName) return `Build ${n}`;
    const heroSpec =
      parsedBuild && treeData
        ? activeHeroSubtree(treeData.nodes, parsedBuild.nodes)
        : null;
    const prefix = heroSpec ? `${heroSpec} ` : "";
    return `Build ${n} — ${prefix}${specDisplayName} ${classDisplayName}`;
  };

  const handleClassSelect = (id) => {
    if (classLocked) return;
    setLocalClassId(id);
    // Reset spec + interactive tree when class changes in interactive mode
    if (buildStrings.length === 0) clearAllBuilds();
  };

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
                  onRemove={() => removeBuild(i)}
                  onRename={(v) => setBuildName(i, v)}
                  onEdit={() => editBuild(i)}
                />
              );
            }

            // Empty input slot — error is only shown on the primary empty slot
            // (the one at filledCount, i.e. the first empty one)
            const isPrimary = i === filledCount;
            return (
              <EmptySlot
                key={`empty-${i}`}
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

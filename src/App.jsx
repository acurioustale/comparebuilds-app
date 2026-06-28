import { useState, useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import BuildManager from "./components/BuildManager";
import HeatmapTree from "./components/HeatmapTree";
import InteractiveTalentTree from "./components/InteractiveTalentTree";
import SideBySideDiff from "./components/SideBySideDiff";
import TalentTree from "./components/TalentTree";
import { useBuildsStore, MAX_BUILDS } from "./store/buildsStore";
import { buildGrantedSeed, computeInvalidNodeIds } from "./lib/treeLogic";
import {
  byId,
  treeNaturalWidths,
  pairedNaturalWidths,
} from "./components/treeLayout";
import FitToWidth from "./components/FitToWidth";
import { resolveRoute } from "./lib/route";
import { decodeBuildsHash } from "./lib/shareLink";
import { matchNodeIds } from "./lib/talentSearch";
import {
  SearchContext,
  ChangesFilterContext,
  SpotlightContext,
} from "./components/SearchContext";
import TalentSearch from "./components/TalentSearch";
import DiffSummaryTable from "./components/DiffSummaryTable";
import {
  THEME_STORAGE_KEY,
  THEME_COLORS,
  resolveMode,
  resolveTheme,
  nextMode,
} from "./lib/theme";

// Stable empty match set so the search memo keeps a constant reference when idle.
const EMPTY_MATCH = new Set();

// ─── Theme ──────────────────────────────────────────────────────────────────

function prefersLight() {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-color-scheme: light)").matches
  );
}

// localStorage can be absent (SSR/tests) or throw on access (Safari private
// mode), so every touch is guarded — a failure just means "no stored mode".
function readStoredMode() {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

// "auto" is the absence of an override, so it clears the key rather than storing
// a value (matching acurioustale.de and the inline script, which only honours an
// explicit light/dark).
function writeStoredMode(mode) {
  try {
    if (mode === "auto") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
}

// Reflect the chosen mode on the document. Only an explicit light/dark override
// sets data-theme (which flips color-scheme in CSS); "auto" removes it so the
// `color-scheme: light dark` + light-dark() palette follows the OS on its own.
// The <meta name="theme-color"> chrome colour still needs the *resolved* theme,
// since light-dark() doesn't reach the meta tag.
function applyTheme(mode, resolvedTheme) {
  const root = document.documentElement;
  if (mode === "auto") delete root.dataset.theme;
  else root.dataset.theme = mode;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLORS[resolvedTheme]);
}

function useTheme() {
  const [mode, setMode] = useState(() => resolveMode(readStoredMode()));
  const [systemLight, setSystemLight] = useState(prefersLight);

  // The resolved theme: "auto" follows the OS, explicit modes win. Used for the
  // meta theme-color (CSS handles the palette itself via color-scheme).
  const theme = resolveTheme(mode, systemLight);

  useEffect(() => {
    applyTheme(mode, theme);
  }, [mode, theme]);

  // Track the OS preference live so "auto" re-resolves on an OS change and the
  // cycle order (derived from the OS) stays correct between clicks.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (e) => setSystemLight(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const cycleTheme = () =>
    setMode((current) => {
      const next = nextMode(current, systemLight);
      writeStoredMode(next);
      return next;
    });

  return { mode, theme, next: nextMode(mode, systemLight), cycleTheme };
}

// A three-way cycle: auto (follow OS) → light → dark, with the glyph showing the
// CURRENT mode and the label announcing where the next click lands. Deliberately
// understated: a borderless glyph that blends into the header chrome, dimmed by
// default and warming to gold on hover/focus, so it stays out of the way until
// you go looking for it. Glyphs and label match the toggle on acurioustale.de so
// the two sites read identically.
const MODE_GLYPH = { auto: "◐", light: "☼", dark: "☾" };

function ThemeToggle({ mode, next, onCycle }) {
  const label = `Theme: ${mode} — switch to ${next}`;
  return (
    <button
      type="button"
      onClick={onCycle}
      className="bg-transparent border-0 p-1 rounded text-lg leading-none cursor-pointer text-wow-muted/50 hover:text-wow-gold focus-visible:text-wow-gold transition-colors"
      aria-label={label}
      title={label}
    >
      {MODE_GLYPH[mode]}
    </button>
  );
}

// Comparison-only toggle: dim every node the builds agree on, leaving just the
// differences. One control for both views — in the diff "differences" means a
// node differs between the two builds; in the heatmap it means a contested node
// (picked by some builds but not all).
function ChangesFilterToggle({ value, onChange }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      aria-pressed={value}
      className={`wow-btn text-xs px-3 py-1.5 rounded select-none transition-colors ${
        value ? "ring-1 ring-wow-gold text-wow-gold" : "text-wow-muted"
      }`}
      title="Dim nodes the builds share; show only where they differ"
    >
      Changes only
    </button>
  );
}

// Search footer, divided from the tree by a hairline, rendered at the bottom
// inside a tree panel (WoW-style — the search lives in the talent frame, not above it).
function PanelFooter({ children }) {
  return (
    <div className="mt-3 pt-3" style={{ borderTop: "1px solid #3a2e1a" }}>
      {children}
    </div>
  );
}

// Wraps a tree/comparison panel so it scales to fit the viewport width, centered.
// FitToWidth is the full-width measurer; the inner card hugs its content (w-max).
function TreeCard({ children }) {
  return (
    <div className="mt-6">
      <FitToWidth>
        <div className="p-4 wow-panel rounded w-max">{children}</div>
      </FitToWidth>
    </div>
  );
}

// Computes invalidity for a single imported build and wraps TalentTree. `widths`
// (single-tree geometry) drives the FitToWidth coordinator's layout + zoom.
function SingleBuildView({ treeData, parsedBuild, widths, footer = null }) {
  const nodeById = useMemo(() => byId(treeData.nodes), [treeData]);

  // Include alreadyGranted nodes so prerequisite checks evaluate correctly
  const fullSelected = useMemo(
    () => ({ ...buildGrantedSeed(treeData), ...parsedBuild.nodes }),
    [treeData, parsedBuild],
  );

  const invalidNodeIds = useMemo(
    () => computeInvalidNodeIds(treeData.nodes, fullSelected, nodeById),
    [treeData.nodes, fullSelected, nodeById],
  );

  return (
    <div className="mt-6">
      <FitToWidth widths={widths}>
        {(layout) => (
          <div className="p-4 wow-panel rounded w-max">
            <TalentTree
              treeData={treeData}
              selectedNodes={parsedBuild.nodes}
              invalidNodeIds={invalidNodeIds}
              layout={layout}
            />
            {footer && <PanelFooter>{footer}</PanelFooter>}
          </div>
        )}
      </FitToWidth>
    </div>
  );
}

function MainView() {
  const {
    treeData,
    parsedBuilds,
    buildStrings,
    buildNames,
    classNodes,
    addingBuild,
    startAddingBuild,
    editingIndex,
  } = useBuildsStore(
    useShallow((s) => ({
      treeData: s.treeData,
      parsedBuilds: s.parsedBuilds,
      buildStrings: s.buildStrings,
      buildNames: s.buildNames,
      classNodes: s.classNodes,
      addingBuild: s.addingBuild,
      startAddingBuild: s.startAddingBuild,
      editingIndex: s.editingIndex,
    })),
  );
  // Comparison views are width-fit per build by the FitToWidth coordinator. The
  // single tree and the 3+ build heatmap share the single-tree geometry; the
  // two-build diff has its own (paired) geometry.
  const treeWidths = useMemo(
    () => (treeData ? treeNaturalWidths(treeData) : null),
    [treeData],
  );
  const pairedWidths = useMemo(
    () => (treeData ? pairedNaturalWidths(treeData) : null),
    [treeData],
  );

  // Search/filter state, shared with every tree node via SearchContext.
  const [query, setQuery] = useState("");
  const matchIds = useMemo(
    () => (treeData ? matchNodeIds(query, treeData.nodes) : EMPTY_MATCH),
    [query, treeData],
  );
  const search = useMemo(
    () => ({ active: query.trim().length > 0, matchIds }),
    [query, matchIds],
  );

  // "Changes only" filter, applied to the diff (2 builds) and heatmap (3+). A view
  // preference, so it stays in component state rather than the persisted store.
  const [changesOnly, setChangesOnly] = useState(false);
  const [spotlightId, setSpotlightId] = useState(null);

  // Valid (parsed) builds with their display labels. Memoised so the arrays fed
  // to the comparison views keep a stable identity across unrelated re-renders (a
  // search keystroke, the changes-only toggle, a theme change) — otherwise every
  // such render would bust HeatmapTree's computeStats / SideBySideDiff's diff
  // memos with fresh array references and recompute over every node.
  const valid = useMemo(
    () =>
      parsedBuilds
        .map((p, i) => ({
          parsed: p,
          label: buildNames[i]?.trim() || `Build ${i + 1}`,
        }))
        .filter(({ parsed }) => parsed),
    [parsedBuilds, buildNames],
  );
  const validParsed = useMemo(() => valid.map((v) => v.parsed), [valid]);
  const validLabels = useMemo(() => valid.map((v) => v.label), [valid]);

  if (!treeData) return null;

  // The search field lives at the bottom of the active tree panel (WoW-style),
  // passed in as a footer rather than floating above the box.
  const searchFooter = (
    <TalentSearch
      value={query}
      onChange={setQuery}
      matchCount={matchIds.size}
    />
  );

  // Wraps a view in the search provider so every tree node sees the query.
  const withSearch = (content) => (
    <SearchContext.Provider value={search}>{content}</SearchContext.Provider>
  );

  // No builds yet: pure interactive mode
  if (buildStrings.length === 0) {
    return withSearch(
      <TreeCard>
        <InteractiveTalentTree
          treeData={treeData}
          classNodes={classNodes}
          searchSlot={searchFooter}
        />
      </TreeCard>,
    );
  }

  // The search footer belongs to whichever tree box is active. While adding a
  // build it goes in the interactive panel (below); otherwise it sits in the
  // comparison/single panel. Either way there is exactly one search field.
  const comparisonFooter = addingBuild ? null : searchFooter;

  let comparisonEl = null;
  if (valid.length >= 3) {
    comparisonEl = (
      <div className="mt-6">
        <FitToWidth widths={treeWidths}>
          {(layout) => (
            <div className="p-4 wow-panel rounded w-max">
              <HeatmapTree
                treeData={treeData}
                builds={validParsed}
                labels={validLabels}
                layout={layout}
                changesToggle={
                  <ChangesFilterToggle
                    value={changesOnly}
                    onChange={setChangesOnly}
                  />
                }
              />
              {comparisonFooter && (
                <PanelFooter>{comparisonFooter}</PanelFooter>
              )}
            </div>
          )}
        </FitToWidth>
      </div>
    );
  } else if (valid.length === 2) {
    comparisonEl = (
      <div className="mt-6">
        <FitToWidth widths={pairedWidths}>
          {(layout) => (
            <div className="p-4 wow-panel rounded w-max">
              <SideBySideDiff
                treeData={treeData}
                buildA={valid[0].parsed}
                buildB={valid[1].parsed}
                labelA={valid[0].label}
                labelB={valid[1].label}
                layout={layout}
                changesToggle={
                  <ChangesFilterToggle
                    value={changesOnly}
                    onChange={setChangesOnly}
                  />
                }
              />
              {comparisonFooter && (
                <PanelFooter>{comparisonFooter}</PanelFooter>
              )}
            </div>
          )}
        </FitToWidth>
      </div>
    );
  } else if (valid.length === 1) {
    comparisonEl = (
      <SingleBuildView
        treeData={treeData}
        parsedBuild={valid[0].parsed}
        widths={treeWidths}
        footer={comparisonFooter}
      />
    );
  }

  const canAddMore = buildStrings.length < MAX_BUILDS;

  return withSearch(
    <>
      {/* Interactive tree shown while building another */}
      {addingBuild && (
        <TreeCard>
          {editingIndex != null && (
            <p className="text-wow-gold-dark text-xs uppercase tracking-widest mb-2 text-center">
              Editing Build {editingIndex + 1}
            </p>
          )}
          <InteractiveTalentTree
            treeData={treeData}
            classNodes={classNodes}
            searchSlot={searchFooter}
          />
        </TreeCard>
      )}

      {/* Offer to add another build when not already in interactive mode */}
      {!addingBuild && canAddMore && (
        <div className="mt-4 flex justify-center">
          <button
            onClick={startAddingBuild}
            className="wow-btn px-4 py-2 text-sm rounded"
          >
            + Add Another Build
          </button>
        </div>
      )}

      {/* The changes-only toggle now lives inside each comparison view (the diff
          panel's top row and the heatmap's legend line), so there's no floating
          control here anymore. */}
      <ChangesFilterContext.Provider value={changesOnly}>
        <SpotlightContext.Provider value={spotlightId}>
          {comparisonEl}
          {valid.length >= 2 && (
            <DiffSummaryTable
              treeData={treeData}
              valid={valid}
              setSpotlightId={setSpotlightId}
            />
          )}
        </SpotlightContext.Provider>
      </ChangesFilterContext.Provider>
    </>,
  );
}

// ─── Share rehydration ────────────────────────────────────────────────────────

function useShareRehydration() {
  const {
    addBuild,
    clearAllBuilds,
    rehydrateTreeData,
    setBuildNames,
    preloadSpec,
    setSharedLayoutHash,
  } = useBuildsStore(
    useShallow((s) => ({
      addBuild: s.addBuild,
      clearAllBuilds: s.clearAllBuilds,
      rehydrateTreeData: s.rehydrateTreeData,
      setBuildNames: s.setBuildNames,
      preloadSpec: s.preloadSpec,
      setSharedLayoutHash: s.setSharedLayoutHash,
    })),
  );
  const [shareError, setShareError] = useState(null);
  // Guard against React StrictMode invoking this effect twice in development,
  // which would otherwise rehydrate (and add) every shared build twice.
  const hasRehydrated = useRef(false);

  useEffect(() => {
    if (hasRehydrated.current) return;
    hasRehydrated.current = true;

    // Map shared slot names back onto the builds that actually landed. addBuild
    // silently skips duplicates and spec mismatches, so applying the names
    // positionally would shift every later name onto the wrong build once a slot
    // is skipped — key by the build string instead, which survives reordering and
    // de-duplication.
    const applyAlignedNames = (builds, names) => {
      if (!names?.some(Boolean)) return;
      const nameByBuild = new Map(builds.map((b, i) => [b, names[i] ?? ""]));
      const landed = useBuildsStore.getState().buildStrings;
      const aligned = landed.map((b) => nameByBuild.get(b) ?? "");
      if (aligned.some(Boolean)) setBuildNames(aligned);
    };

    const route = resolveRoute();

    // No share in the URL: restore whatever was autosaved to localStorage. The
    // persist middleware has already rehydrated the small slices synchronously;
    // here we rebuild the derived tree/parsed state from the restored builds.
    if (route.kind === "local") {
      rehydrateTreeData();
      return;
    }

    // A prerendered spec landing page (/<class>/<spec>). For a first-time visitor
    // (nothing persisted) open that spec's calculator; a returning user's saved
    // work takes precedence so a marketing/search link never discards it.
    if (route.kind === "spec-page") {
      if (useBuildsStore.getState().specId == null) preloadSpec(route.specId);
      else rehydrateTreeData();
      return;
    }

    // A shared link wins over any locally saved state: discard the restored
    // local builds first so they can't trigger a spec-mismatch or linger
    // alongside the shared build.
    clearAllBuilds();

    // Client-side instant link: the builds are encoded in the hash itself, so
    // no network round-trip is needed.
    if (route.kind === "client-share") {
      const decoded = decodeBuildsHash(route.token);
      if (!decoded) {
        setShareError("This share link is malformed.");
        return;
      }
      (async () => {
        if (decoded.layoutHash) setSharedLayoutHash(decoded.layoutHash);
        for (const buildString of decoded.builds) {
          await addBuild(buildString);
        }
        applyAlignedNames(decoded.builds, decoded.names);
        history.replaceState(null, "", window.location.pathname);
      })();
      return;
    }

    // Server short-link: fetch the stored builds by id.
    (async () => {
      try {
        const apiBase = import.meta.env.BASE_URL + "api/share.php";
        const res = await fetch(
          `${apiBase}?id=${encodeURIComponent(route.id)}`,
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setShareError(body.error ?? "Shared link not found or has expired.");
          return;
        }
        const data = await res.json();
        if (!Array.isArray(data.builds) || data.builds.length === 0) {
          setShareError("Invalid share data.");
          return;
        }
        if (data.layoutHash) setSharedLayoutHash(data.layoutHash);
        for (const buildString of data.builds) {
          await addBuild(buildString);
        }
        applyAlignedNames(
          data.builds,
          Array.isArray(data.labels) ? data.labels : [],
        );
        // Remove hash so it doesn't re-trigger on manual reload
        history.replaceState(null, "", window.location.pathname);
      } catch {
        setShareError(
          "Failed to load shared builds. Check your connection and try again.",
        );
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { shareError, dismissShareError: () => setShareError(null) };
}

// ─── Main app ─────────────────────────────────────────────────────────────────

export default function App() {
  const { shareError, dismissShareError } = useShareRehydration();
  const { mode, next, cycleTheme } = useTheme();
  const { layoutHash, sharedLayoutHash } = useBuildsStore(
    useShallow((s) => ({
      layoutHash: s.layoutHash,
      sharedLayoutHash: s.sharedLayoutHash,
    })),
  );
  const patchWarning =
    layoutHash && sharedLayoutHash && layoutHash !== sharedLayoutHash;

  return (
    <div className="min-h-screen text-wow-text flex flex-col relative">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header
        className="wow-chrome relative py-6 px-4 text-center select-none"
        style={{
          borderBottom: "1px solid transparent",
          borderImage:
            "linear-gradient(to right, transparent 8%, rgba(200,168,75,0.55), transparent 92%) 1",
        }}
      >
        <div className="absolute right-4 top-4">
          <ThemeToggle mode={mode} next={next} onCycle={cycleTheme} />
        </div>
        <div className="flex items-center justify-center gap-3">
          <img
            src={`${import.meta.env.BASE_URL}favicon.svg`}
            alt=""
            width={50}
            height={50}
            draggable={false}
            className="shrink-0"
            style={{ filter: "drop-shadow(0 0 10px rgba(200,168,75,0.35))" }}
          />
          <h1
            className="text-[2.75rem] text-wow-gold tracking-[0.16em] leading-none"
            style={{
              fontFamily: "'FrizQuadrata', 'Palatino Linotype', serif",
              textShadow:
                "0 0 18px rgba(200,168,75,0.35), 0 2px 5px rgba(0,0,0,0.6)",
            }}
          >
            Compare Builds
          </h1>
        </div>
        <p className="text-wow-muted text-xs uppercase tracking-[0.35em] mt-2">
          WoW Talent Build Comparison
        </p>
      </header>

      {/* ── Main ───────────────────────────────────────────────────────────── */}
      <main className="flex-1 p-4 pt-6">
        {shareError && (
          <div
            className="max-w-2xl mx-auto mb-4 flex items-start gap-3 px-3 py-2.5 rounded text-xs"
            style={{
              background: "rgba(60,10,10,0.7)",
              border: "1px solid rgba(180,40,40,0.4)",
              color: "#ffaaaa",
            }}
          >
            <span className="flex-1">{shareError}</span>
            <button
              onClick={dismissShareError}
              className="shrink-0 transition-colors leading-none"
              style={{ color: "#ff6666" }}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}
        {patchWarning && (
          <div
            className="max-w-2xl mx-auto mb-4 px-3 py-2.5 rounded text-xs text-center"
            style={{
              background: "rgba(60,10,10,0.7)",
              border: "1px solid rgba(180,40,40,0.4)",
              color: "#ffaaaa",
            }}
          >
            These builds were created during a previous game patch. Talent
            positions may have shifted, causing points to misalign or disappear.
          </div>
        )}
        <BuildManager />
        <MainView />
      </main>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <footer
        className="wow-chrome py-4 px-4 text-center space-y-0.5"
        style={{
          borderTop: "1px solid transparent",
          borderImage:
            "linear-gradient(to right, transparent 8%, rgba(200,168,75,0.45), transparent 92%) 1",
        }}
      >
        <p className="text-wow-muted text-xs">
          2026{" "}
          <a
            href="https://acurioustale.de"
            className="hover:text-wow-gold transition-colors"
          >
            acurioustale
          </a>
        </p>
        <p className="text-wow-dim text-xs">
          Built with React, Vite, and Tailwind CSS
        </p>
      </footer>
    </div>
  );
}

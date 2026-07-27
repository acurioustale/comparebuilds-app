import {
  useState,
  useMemo,
  useDeferredValue,
  useCallback,
  memo,
  useEffect,
} from "react";
import { useShallow } from "zustand/react/shallow";
import HeatmapTree from "./HeatmapTree";
import InteractiveTalentTree from "./InteractiveTalentTree";
import SideBySideDiff from "./SideBySideDiff";
import TalentTree from "./TalentTree";
import FitToWidth from "./FitToWidth";
import TalentSearch from "./TalentSearch";
import DiffSummaryTable from "./DiffSummaryTable";
import { useBuildsStore, MAX_BUILDS } from "../store/buildsStore";
import { buildGrantedSeed, computeInvalidNodeIds } from "../lib/treeLogic";
import { computeDiff } from "../lib/diff";
import { computeStats } from "../lib/heatmap";
import { defaultBuildLabel } from "../lib/buildLabel";
import classesIndex from "../data/classes.json";
import { byId, treeNaturalWidths, pairedNaturalWidths } from "./treeLayout";
import { matchNodeIds } from "../lib/talentSearch";
import {
  SearchContext,
  ChangesFilterContext,
  SpotlightContext,
} from "./SearchContext";

const EMPTY_MATCH = new Set();

const ChangesFilterToggle = memo(function ChangesFilterToggle({
  value,
  onChange,
}) {
  const handleClick = useCallback(() => onChange(!value), [onChange, value]);
  return (
    <button
      type="button"
      onClick={handleClick}
      aria-pressed={value}
      className={`wow-btn text-xs px-3 py-1.5 rounded select-none transition-colors ${
        value ? "ring-1 ring-wow-gold text-wow-gold" : "text-wow-muted"
      }`}
      title="Dim nodes the builds share; show only where they differ"
    >
      Differences only
    </button>
  );
});

function PanelFooter({ children }) {
  return (
    <div className="mt-3 pt-3" style={{ borderTop: "1px solid #3a2e1a" }}>
      {children}
    </div>
  );
}

function TreeCard({ children }) {
  return (
    <div className="mt-6">
      <FitToWidth>
        <div className="p-4 wow-panel rounded w-max">{children}</div>
      </FitToWidth>
    </div>
  );
}

function SingleBuildView({ treeData, parsedBuild, widths, footer = null }) {
  const nodeById = useMemo(() => byId(treeData.nodes), [treeData]);

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

function ThreePlusBuildsView({
  treeData,
  validParsed,
  validLabels,
  stats,
  widths,
  footer,
  changesOnly,
  setChangesOnly,
}) {
  return (
    <div className="mt-6">
      <FitToWidth widths={widths}>
        {(layout) => (
          <div className="p-4 wow-panel rounded w-max">
            <HeatmapTree
              treeData={treeData}
              builds={validParsed}
              labels={validLabels}
              stats={stats}
              layout={layout}
              changesToggle={
                <ChangesFilterToggle
                  value={changesOnly}
                  onChange={setChangesOnly}
                />
              }
            />
            {footer && <PanelFooter>{footer}</PanelFooter>}
          </div>
        )}
      </FitToWidth>
    </div>
  );
}

function PairedBuildView({
  treeData,
  buildA,
  buildB,
  labelA,
  labelB,
  diff,
  widths,
  footer,
  changesOnly,
  setChangesOnly,
  onSwap,
}) {
  return (
    <div className="mt-6">
      <FitToWidth widths={widths}>
        {(layout) => (
          <div className="p-4 wow-panel rounded w-max">
            <SideBySideDiff
              treeData={treeData}
              buildA={buildA}
              buildB={buildB}
              labelA={labelA}
              labelB={labelB}
              diff={diff}
              layout={layout}
              onSwap={onSwap}
              changesToggle={
                <ChangesFilterToggle
                  value={changesOnly}
                  onChange={setChangesOnly}
                />
              }
            />
            {footer && <PanelFooter>{footer}</PanelFooter>}
          </div>
        )}
      </FitToWidth>
    </div>
  );
}

export default function MainView() {
  const {
    treeData,
    parsedBuilds,
    buildStrings,
    buildNames,
    classNodes,
    specId,
    addingBuild,
    startAddingBuild,
    editingIndex,
    swapBuilds,
  } = useBuildsStore(
    useShallow((s) => ({
      treeData: s.treeData,
      parsedBuilds: s.parsedBuilds,
      buildStrings: s.buildStrings,
      buildNames: s.buildNames,
      classNodes: s.classNodes,
      specId: s.specId,
      addingBuild: s.addingBuild,
      startAddingBuild: s.startAddingBuild,
      editingIndex: s.editingIndex,
      swapBuilds: s.swapBuilds,
    })),
  );

  // Class/spec display names for the default build labels, derived from specId
  // the same way BuildManager does, so the labels in the comparison views match
  // the build-manager slots and the SimC export exactly (all via defaultBuildLabel).
  const activeClass = useMemo(
    () => classesIndex.find((c) => c.specs.some((s) => s.id === specId)),
    [specId],
  );
  const classDisplayName = activeClass?.displayName ?? "";
  const specDisplayName =
    activeClass?.specs.find((s) => s.id === specId)?.displayName ?? "";

  const treeWidths = useMemo(
    () => (treeData ? treeNaturalWidths(treeData) : null),
    [treeData],
  );
  const pairedWidths = useMemo(
    () => (treeData ? pairedNaturalWidths(treeData) : null),
    [treeData],
  );

  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const matchIds = useMemo(
    () =>
      treeData ? matchNodeIds(deferredQuery, treeData.nodes) : EMPTY_MATCH,
    [deferredQuery, treeData],
  );
  const search = useMemo(
    () => ({ active: deferredQuery.trim().length > 0, matchIds }),
    [deferredQuery, matchIds],
  );

  const [changesOnly, setChangesOnly] = useState(false);
  const [spotlightId, setSpotlightId] = useState(null);

  // The parsed slice is deliberately memoised WITHOUT the labels: renaming a
  // build fires setBuildName per keystroke, and folding buildNames into the
  // same memo used to mint a fresh identity per keystroke — re-running the
  // O(nodes × builds) diff/stats passes below and reconciling the whole
  // comparison subtree to change a label string none of them read.
  const validEntries = useMemo(
    () =>
      parsedBuilds
        .map((p, i) => ({ index: i, parsed: p }))
        .filter(({ parsed }) => parsed),
    [parsedBuilds],
  );
  const validParsed = useMemo(
    () => validEntries.map((v) => v.parsed),
    [validEntries],
  );
  const validLabels = useMemo(
    () =>
      validEntries.map(
        ({ index, parsed }) =>
          buildNames[index]?.trim() ||
          defaultBuildLabel({
            index: index + 1,
            total: buildStrings.length,
            className: classDisplayName,
            specName: specDisplayName,
            treeData,
            parsedBuild: parsed,
          }),
      ),
    [
      validEntries,
      buildNames,
      buildStrings.length,
      classDisplayName,
      specDisplayName,
      treeData,
    ],
  );
  // Combined shape for consumers that want both (the diff summary table).
  const valid = useMemo(
    () => validEntries.map((v, k) => ({ ...v, label: validLabels[k] })),
    [validEntries, validLabels],
  );

  // The comparison view (paired diff or heatmap) and the DiffSummaryTable mount
  // together for every 2+-build comparison and both read the same diff/adoption
  // data. Compute it once here so neither child recomputes: the 2-build diff and
  // the 3+-build adoption stats are each an O(nodes × builds) pass. Both key on
  // the label-free validEntries/validParsed so renames can't invalidate them.
  const pairDiff = useMemo(
    () =>
      treeData && validEntries.length === 2
        ? computeDiff(
            validEntries[0].parsed.nodes,
            validEntries[1].parsed.nodes,
            treeData.nodes,
          )
        : null,
    [treeData, validEntries],
  );
  const heatmapStats = useMemo(
    () =>
      treeData && validEntries.length >= 3
        ? computeStats(validParsed, treeData.nodes)
        : null,
    [treeData, validEntries.length, validParsed],
  );

  // Comparison-only view state must not outlive the comparison. Both live in
  // MainView but their controls only render in the 2+/3+ views: a spotlight
  // survives the DiffSummaryTable unmounting mid-hover, and a left-on
  // "Differences only" toggle would dim the single-build view's entire tree
  // (no highlights → every node reads as unchanged) with no button to turn it
  // off until another build is added.
  const summaryShown = valid.length >= 2;
  useEffect(() => {
    if (!summaryShown) {
      setSpotlightId(null);
      setChangesOnly(false);
    }
  }, [summaryShown, setSpotlightId, setChangesOnly]);

  if (!treeData) return null;

  const searchFooter = (
    <TalentSearch
      value={query}
      onChange={setQuery}
      matchCount={matchIds.size}
    />
  );

  const withSearch = (content) => (
    <SearchContext.Provider value={search}>{content}</SearchContext.Provider>
  );

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

  const comparisonFooter = addingBuild ? null : searchFooter;

  let comparisonEl = null;
  if (validEntries.length >= 3) {
    comparisonEl = (
      <ThreePlusBuildsView
        treeData={treeData}
        validParsed={validParsed}
        validLabels={validLabels}
        stats={heatmapStats}
        widths={treeWidths}
        footer={comparisonFooter}
        changesOnly={changesOnly}
        setChangesOnly={setChangesOnly}
      />
    );
  } else if (validEntries.length === 2) {
    comparisonEl = (
      <PairedBuildView
        treeData={treeData}
        buildA={validEntries[0].parsed}
        buildB={validEntries[1].parsed}
        labelA={validLabels[0]}
        labelB={validLabels[1]}
        diff={pairDiff}
        widths={pairedWidths}
        footer={comparisonFooter}
        changesOnly={changesOnly}
        setChangesOnly={setChangesOnly}
        onSwap={() => swapBuilds(validEntries[0].index, validEntries[1].index)}
      />
    );
  } else if (validEntries.length === 1) {
    comparisonEl = (
      <SingleBuildView
        treeData={treeData}
        parsedBuild={validEntries[0].parsed}
        widths={treeWidths}
        footer={comparisonFooter}
      />
    );
  } else if (!addingBuild) {
    // Build strings were entered but none of them parsed (valid.length === 0),
    // so no tree/diff/heatmap branch applies. Without this the main area would be
    // blank apart from the add button. Explain the failure; the build-manager
    // slots above already flag each unparseable one with a red ✕. Suppressed
    // while addingBuild, where the interactive tree occupies the space instead.
    comparisonEl = (
      <div className="mt-6 flex justify-center">
        <div className="p-4 wow-panel rounded max-w-md text-center">
          <p className="text-wow-gold-dark text-xs uppercase tracking-widest mb-2">
            Nothing to compare
          </p>
          <p className="text-wow-muted text-sm">
            None of the build strings could be decoded — check the flagged slots
            above and paste the loadout string WoW copies from the talent UI.
          </p>
        </div>
      </div>
    );
  }

  const canAddMore = buildStrings.length < MAX_BUILDS;

  return withSearch(
    <>
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

      <ChangesFilterContext.Provider value={changesOnly}>
        <SpotlightContext.Provider value={spotlightId}>
          {comparisonEl}
          {valid.length >= 2 && (
            <DiffSummaryTable
              treeData={treeData}
              valid={valid}
              diff={pairDiff}
              stats={heatmapStats}
              spotlightId={spotlightId}
              setSpotlightId={setSpotlightId}
            />
          )}
        </SpotlightContext.Provider>
      </ChangesFilterContext.Provider>
    </>,
  );
}

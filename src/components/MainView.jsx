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

export default function MainView() {
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

  const summaryShown = valid.length >= 2;
  useEffect(() => {
    if (!summaryShown) setSpotlightId(null);
  }, [summaryShown]);

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
              setSpotlightId={setSpotlightId}
            />
          )}
        </SpotlightContext.Provider>
      </ChangesFilterContext.Provider>
    </>,
  );
}

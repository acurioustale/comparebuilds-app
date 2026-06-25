import { useState, useEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import BuildManager from './components/BuildManager'
import HeatmapTree from './components/HeatmapTree'
import InteractiveTalentTree from './components/InteractiveTalentTree'
import SideBySideDiff from './components/SideBySideDiff'
import TalentTree from './components/TalentTree'
import { useBuildsStore, MAX_BUILDS } from './store/buildsStore'
import { buildGrantedSeed, computeInvalidNodeIds } from './lib/treeLogic'
import { byId, treeNaturalWidths, pairedNaturalWidths } from './components/treeLayout'
import FitToWidth from './components/FitToWidth'
import { resolveRoute } from './lib/route'
import { decodeBuildsHash } from './lib/shareLink'
import { matchNodeIds } from './lib/talentSearch'
import { SearchContext } from './components/SearchContext'
import TalentSearch from './components/TalentSearch'

// Stable empty match set so the search memo keeps a constant reference when idle.
const EMPTY_MATCH = new Set()

// Wraps a tree/comparison panel so it scales to fit the viewport width, centered.
// FitToWidth is the full-width measurer; the inner card hugs its content (w-max).
function TreeCard({ children }) {
  return (
    <div className="mt-6">
      <FitToWidth>
        <div className="p-4 wow-panel rounded w-max">{children}</div>
      </FitToWidth>
    </div>
  )
}

// Computes invalidity for a single imported build and wraps TalentTree. `widths`
// (single-tree geometry) drives the FitToWidth coordinator's layout + zoom.
function SingleBuildView({ treeData, parsedBuild, widths }) {
  const nodeById = useMemo(() => byId(treeData.nodes), [treeData])

  // Include alreadyGranted nodes so prerequisite checks evaluate correctly
  const fullSelected = useMemo(
    () => ({ ...buildGrantedSeed(treeData), ...parsedBuild.nodes }),
    [treeData, parsedBuild],
  )

  const invalidNodeIds = useMemo(
    () => computeInvalidNodeIds(treeData.nodes, fullSelected, nodeById),
    [treeData.nodes, fullSelected, nodeById],
  )

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
          </div>
        )}
      </FitToWidth>
    </div>
  )
}

function MainView() {
  const { treeData, parsedBuilds, buildStrings, buildNames, classNodes, addingBuild, startAddingBuild } = useBuildsStore(
    useShallow((s) => ({
      treeData: s.treeData,
      parsedBuilds: s.parsedBuilds,
      buildStrings: s.buildStrings,
      buildNames: s.buildNames,
      classNodes: s.classNodes,
      addingBuild: s.addingBuild,
      startAddingBuild: s.startAddingBuild,
    })),
  )
  // Comparison views are width-fit per build by the FitToWidth coordinator. The
  // single tree and the 3+ build heatmap share the single-tree geometry; the
  // two-build diff has its own (paired) geometry.
  const treeWidths   = useMemo(() => (treeData ? treeNaturalWidths(treeData) : null), [treeData])
  const pairedWidths = useMemo(() => (treeData ? pairedNaturalWidths(treeData) : null), [treeData])

  // Search/filter state, shared with every tree node via SearchContext.
  const [query, setQuery] = useState('')
  const matchIds = useMemo(
    () => (treeData ? matchNodeIds(query, treeData.nodes) : EMPTY_MATCH),
    [query, treeData],
  )
  const search = useMemo(() => ({ active: query.trim().length > 0, matchIds }), [query, matchIds])

  if (!treeData) return null

  // Wraps a view with the search box + provider so all four view types share it.
  const withSearch = (content) => (
    <SearchContext.Provider value={search}>
      <TalentSearch value={query} onChange={setQuery} matchCount={matchIds.size} />
      {content}
    </SearchContext.Provider>
  )

  // No builds yet: pure interactive mode
  if (buildStrings.length === 0) {
    return withSearch(
      <TreeCard>
        <InteractiveTalentTree treeData={treeData} classNodes={classNodes} />
      </TreeCard>,
    )
  }

  // Builds exist: build the comparison element first
  const valid = parsedBuilds
    .map((p, i) => ({ parsed: p, label: buildNames[i]?.trim() || `Build ${i + 1}` }))
    .filter(({ parsed }) => parsed)

  let comparisonEl = null
  if (valid.length >= 3) {
    comparisonEl = (
      <div className="mt-6">
        <FitToWidth widths={treeWidths}>
          {(layout) => (
            <div className="p-4 wow-panel rounded w-max">
              <HeatmapTree treeData={treeData} builds={valid.map((v) => v.parsed)} layout={layout} />
            </div>
          )}
        </FitToWidth>
      </div>
    )
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
              />
            </div>
          )}
        </FitToWidth>
      </div>
    )
  } else if (valid.length === 1) {
    comparisonEl = <SingleBuildView treeData={treeData} parsedBuild={valid[0].parsed} widths={treeWidths} />
  }

  const canAddMore = buildStrings.length < MAX_BUILDS

  return withSearch(
    <>
      {/* Interactive tree shown while building another */}
      {addingBuild && (
        <TreeCard>
          <InteractiveTalentTree treeData={treeData} classNodes={classNodes} />
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

      {comparisonEl}
    </>,
  )
}

// ─── Share rehydration ────────────────────────────────────────────────────────

function useShareRehydration() {
  const { addBuild, clearAllBuilds, rehydrateTreeData, setBuildNames } = useBuildsStore(
    useShallow((s) => ({
      addBuild: s.addBuild,
      clearAllBuilds: s.clearAllBuilds,
      rehydrateTreeData: s.rehydrateTreeData,
      setBuildNames: s.setBuildNames,
    })),
  )
  const [shareError, setShareError] = useState(null)
  // Guard against React StrictMode invoking this effect twice in development,
  // which would otherwise rehydrate (and add) every shared build twice.
  const hasRehydrated = useRef(false)

  useEffect(() => {
    if (hasRehydrated.current) return
    hasRehydrated.current = true

    const route = resolveRoute()

    // No share in the URL: restore whatever was autosaved to localStorage. The
    // persist middleware has already rehydrated the small slices synchronously;
    // here we rebuild the derived tree/parsed state from the restored builds.
    if (route.kind === 'local') {
      rehydrateTreeData()
      return
    }

    // A shared link wins over any locally saved state: discard the restored
    // local builds first so they can't trigger a spec-mismatch or linger
    // alongside the shared build.
    clearAllBuilds()

    // Client-side instant link: the builds are encoded in the hash itself, so
    // no network round-trip is needed.
    if (route.kind === 'client-share') {
      const decoded = decodeBuildsHash(route.token)
      if (!decoded) {
        setShareError('This share link is malformed.')
        return
      }
      ;(async () => {
        for (const buildString of decoded.builds) {
          await addBuild(buildString)
        }
        if (decoded.names.some(Boolean)) setBuildNames(decoded.names)
        history.replaceState(null, '', window.location.pathname)
      })()
      return
    }

    // Server short-link: fetch the stored builds by id.
    ;(async () => {
      try {
        const apiBase = import.meta.env.BASE_URL + 'api/share.php'
        const res = await fetch(`${apiBase}?id=${encodeURIComponent(route.id)}`)
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          setShareError(body.error ?? 'Shared link not found or has expired.')
          return
        }
        const data = await res.json()
        if (!Array.isArray(data.builds) || data.builds.length === 0) {
          setShareError('Invalid share data.')
          return
        }
        for (const buildString of data.builds) {
          await addBuild(buildString)
        }
        if (Array.isArray(data.labels) && data.labels.some(Boolean)) setBuildNames(data.labels)
        // Remove hash so it doesn't re-trigger on manual reload
        history.replaceState(null, '', window.location.pathname)
      } catch {
        setShareError('Failed to load shared builds. Check your connection and try again.')
      }
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return { shareError, dismissShareError: () => setShareError(null) }
}

// ─── Main app ─────────────────────────────────────────────────────────────────

export default function App() {
  const { shareError, dismissShareError } = useShareRehydration()

  return (
    <div className="min-h-screen text-wow-text flex flex-col relative">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header
        className="wow-chrome py-6 px-4 text-center select-none"
        style={{ borderBottom: '1px solid transparent', borderImage: 'linear-gradient(to right, transparent 8%, rgba(200,168,75,0.55), transparent 92%) 1' }}
      >
        <div className="flex items-center justify-center gap-3">
          <img
            src={`${import.meta.env.BASE_URL}favicon.svg`}
            alt=""
            width={50}
            height={50}
            draggable={false}
            className="shrink-0"
            style={{ filter: 'drop-shadow(0 0 10px rgba(200,168,75,0.35))' }}
          />
          <h1
            className="text-[2.75rem] text-wow-gold tracking-[0.16em] leading-none"
            style={{
              fontFamily: "'FrizQuadrata', 'Palatino Linotype', serif",
              textShadow: '0 0 18px rgba(200,168,75,0.35), 0 2px 5px rgba(0,0,0,0.6)',
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
            <div className="max-w-2xl mx-auto mb-4 flex items-start gap-3 px-3 py-2.5 rounded text-xs"
              style={{ background: 'rgba(60,10,10,0.7)', border: '1px solid rgba(180,40,40,0.4)', color: '#ffaaaa' }}>
              <span className="flex-1">{shareError}</span>
              <button
                onClick={dismissShareError}
                className="shrink-0 transition-colors leading-none"
                style={{ color: '#ff6666' }}
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          )}
          <BuildManager />
          <MainView />
      </main>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <footer
        className="wow-chrome py-4 px-4 text-center space-y-0.5"
        style={{ borderTop: '1px solid transparent', borderImage: 'linear-gradient(to right, transparent 8%, rgba(200,168,75,0.45), transparent 92%) 1' }}
      >
        <p className="text-wow-muted text-xs">
          2026{' '}
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
  )
}


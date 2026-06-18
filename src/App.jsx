import { useState, useEffect, useMemo, useRef } from 'react'
import BuildManager from './components/BuildManager'
import HeatmapTree from './components/HeatmapTree'
import InteractiveTalentTree from './components/InteractiveTalentTree'
import SideBySideDiff from './components/SideBySideDiff'
import TalentTree from './components/TalentTree'
import { useBuildsStore, MAX_BUILDS } from './store/buildsStore'
import { buildGrantedSeed, computeInvalidNodeIds } from './lib/treeLogic'
import { byId } from './components/treeLayout'

// Computes invalidity for a single imported build and wraps TalentTree.
function SingleBuildView({ treeData, parsedBuild }) {
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
    <div className="mt-6 flex justify-center">
      <div className="p-4 wow-panel rounded">
        <TalentTree
          treeData={treeData}
          selectedNodes={parsedBuild.nodes}
          invalidNodeIds={invalidNodeIds}
        />
      </div>
    </div>
  )
}

function MainView() {
  const { treeData, parsedBuilds, buildStrings, classNodes, addingBuild, startAddingBuild } = useBuildsStore()
  if (!treeData) return null

  // No builds yet: pure interactive mode
  if (buildStrings.length === 0) {
    return (
      <div className="mt-6 flex justify-center">
        <div className="p-4 wow-panel rounded">
          <InteractiveTalentTree treeData={treeData} classNodes={classNodes} />
        </div>
      </div>
    )
  }

  // Builds exist: build the comparison element first
  const valid = parsedBuilds
    .map((p, i) => ({ parsed: p, label: `Build ${i + 1}` }))
    .filter(({ parsed }) => parsed)

  let comparisonEl = null
  if (valid.length >= 3) {
    comparisonEl = (
      <div className="mt-6 flex justify-center">
        <div className="p-4 wow-panel rounded">
          <HeatmapTree treeData={treeData} builds={valid.map((v) => v.parsed)} />
        </div>
      </div>
    )
  } else if (valid.length === 2) {
    comparisonEl = (
      <div className="mt-6 flex justify-center">
        <div className="p-4 wow-panel rounded">
          <SideBySideDiff
            treeData={treeData}
            buildA={valid[0].parsed}
            buildB={valid[1].parsed}
            labelA={valid[0].label}
            labelB={valid[1].label}
          />
        </div>
      </div>
    )
  } else if (valid.length === 1) {
    comparisonEl = <SingleBuildView treeData={treeData} parsedBuild={valid[0].parsed} />
  }

  const canAddMore = buildStrings.length < MAX_BUILDS

  return (
    <>
      {/* Interactive tree shown while building another */}
      {addingBuild && (
        <div className="mt-6 flex justify-center">
          <div className="p-4 wow-panel rounded">
            <InteractiveTalentTree treeData={treeData} classNodes={classNodes} />
          </div>
        </div>
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
    </>
  )
}

// ─── Share rehydration ────────────────────────────────────────────────────────

function useShareRehydration() {
  const { addBuild } = useBuildsStore()
  const [shareError, setShareError] = useState(null)
  // Guard against React StrictMode invoking this effect twice in development,
  // which would otherwise rehydrate (and add) every shared build twice.
  const hasRehydrated = useRef(false)

  useEffect(() => {
    if (hasRehydrated.current) return
    hasRehydrated.current = true

    const hash = window.location.hash.slice(1)
    if (!hash || !/^[A-Za-z0-9]{6}$/.test(hash)) return

    ;(async () => {
      try {
        const apiBase = import.meta.env.BASE_URL + 'api/share.php'
        const res = await fetch(`${apiBase}?id=${encodeURIComponent(hash)}`)
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
    <>
    <div className="min-h-screen text-wow-text flex flex-col relative">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="wow-chrome py-5 px-4 border-b border-wow-dim text-center select-none">
        <h1
          className="text-[2.75rem] text-wow-gold tracking-widest leading-none"
          style={{ fontFamily: "'FrizQuadrata', 'Palatino Linotype', serif" }}
        >
          Compare Builds
        </h1>
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
      <footer className="wow-chrome py-4 px-4 border-t border-wow-dim text-center space-y-0.5">
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
    </>
  )
}


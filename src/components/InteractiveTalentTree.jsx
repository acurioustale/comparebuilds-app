import { useCallback, useMemo, useState } from 'react'
import Tippy from '@tippyjs/react'
import 'tippy.js/dist/tippy.css'
import TalentTree from './TalentTree'
import { generateBuildString } from '../lib/buildString'
import { computeInvalidNodeIds, buildGrantedSeed } from '../lib/treeLogic'
import { sectionPoints, canSpendPoint, activeHeroSubtree } from '../lib/spendRules'
import { byId } from './treeLayout'
import { useBuildsStore } from '../store/buildsStore'

// ─── Section bar (label + counter + per-section clear) ───────────────────────

function SectionBar({ label, spent, max, onClear }) {
  const full = spent >= max
  return (
    <div className="flex items-center gap-1.5 text-xs select-none">
      <span className="text-wow-gold-dark uppercase tracking-wider w-10 shrink-0">{label}</span>
      <span className={`tabular-nums font-mono ${full ? 'text-green-400' : 'text-wow-muted'}`}>
        {spent}<span className="text-wow-dim">/{max}</span>
      </span>
      <button
        onClick={onClear}
        disabled={spent === 0}
        className="wow-btn text-[10px] px-1.5 py-0.5 rounded select-none"
      >
        Clear
      </button>
    </div>
  )
}

// ─── Export button ────────────────────────────────────────────────────────────

function ExportButton({ onClick, state, invalidCount, pointsRemaining }) {
  const hasInvalid = invalidCount > 0
  const hasUnspent = pointsRemaining.class > 0 || pointsRemaining.spec > 0 || pointsRemaining.hero > 0
  const isDisabled = state !== 'idle' || hasInvalid || hasUnspent

  const label =
    hasInvalid           ? 'Resolve conflicts first' :
    state === 'copying'  ? 'Exporting…' :
    state === 'done'     ? 'Copied & added!' :
    state === 'error'    ? 'Failed' : 'Export build'

  const btn = (
    <button
      onClick={!isDisabled ? onClick : undefined}
      disabled={isDisabled}
      className="wow-btn text-xs px-3 py-1.5 rounded text-wow-text select-none disabled:opacity-30 disabled:cursor-not-allowed"
    >
      {label}
    </button>
  )

  if (hasInvalid) {
    return (
      <Tippy
        content={`${invalidCount} node${invalidCount > 1 ? 's have' : ' has'} unmet prerequisites or gate requirements. Right-click the red-flagged nodes to remove them, or re-activate the missing prerequisite.`}
        placement="bottom"
        delay={[200, 0]}
      >
        <span style={{ display: 'inline-block' }}>{btn}</span>
      </Tippy>
    )
  }

  if (hasUnspent) {
    const lines = []
    if (pointsRemaining.class > 0) lines.push(`Class: ${pointsRemaining.class} remaining`)
    if (pointsRemaining.spec > 0)  lines.push(`Spec: ${pointsRemaining.spec} remaining`)
    if (pointsRemaining.hero > 0)  lines.push(`Hero: ${pointsRemaining.hero} remaining`)
    return (
      <Tippy
        content={
          <div>
            <div style={{ marginBottom: '0.2rem' }}>Spend all talent points before exporting.</div>
            {lines.map((l) => <div key={l} style={{ color: '#9a8a6a' }}>{l}</div>)}
          </div>
        }
        placement="bottom"
        delay={[200, 0]}
      >
        <span style={{ display: 'inline-block' }}>{btn}</span>
      </Tippy>
    )
  }

  return btn
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function InteractiveTalentTree({ treeData, classNodes }) {
  const { specId, interactiveNodes: selected, setInteractiveNodes, addBuild, finishAddingBuild } = useBuildsStore()
  const [exportState, setExportState] = useState('idle')

  const budget = treeData.pointBudget

  const nodeById = useMemo(() => byId(treeData.nodes), [treeData])

  // ── Invalid-node detection ──────────────────────────────────────────────────

  const invalidNodeIds = useMemo(
    () => computeInvalidNodeIds(treeData.nodes, selected, nodeById),
    [treeData.nodes, selected, nodeById],
  )

  // ── Click handlers ──────────────────────────────────────────────────────────

  const handleClick = useCallback((nodeId, choiceIdx = null) => {
    const node = nodeById[nodeId]
    if (!node || node.alreadyGranted) return

    const sel = selected[nodeId]

    if (!sel) {
      if (!canSpendPoint(node, treeData.nodes, selected, nodeById, budget)) return
      const entryChosen = node.type === 'choice' ? (choiceIdx ?? 0) : null
      setInteractiveNodes({ ...selected, [nodeId]: { pointsInvested: 1, entryChosen } })
    } else if (node.type === 'choice') {
      const numChoices = node.choices?.length ?? 1
      const next = choiceIdx !== null ? choiceIdx : ((sel.entryChosen ?? 0) + 1) % numChoices
      if (next !== sel.entryChosen) {
        setInteractiveNodes({ ...selected, [nodeId]: { ...sel, entryChosen: next } })
      }
    } else if (sel.pointsInvested < node.maxRanks) {
      if (!canSpendPoint(node, treeData.nodes, selected, nodeById, budget)) return
      setInteractiveNodes({ ...selected, [nodeId]: { ...sel, pointsInvested: sel.pointsInvested + 1 } })
    }
  }, [selected, nodeById, treeData.nodes, setInteractiveNodes])

  const handleRightClick = useCallback((nodeId) => {
    const node = nodeById[nodeId]
    if (!node || node.alreadyGranted) return
    const sel = selected[nodeId]
    if (!sel) return

    if (node.type === 'choice') {
      const next = { ...selected }
      delete next[nodeId]
      setInteractiveNodes(next)
    } else if (sel.pointsInvested > 1) {
      setInteractiveNodes({ ...selected, [nodeId]: { ...sel, pointsInvested: sel.pointsInvested - 1 } })
    } else {
      const next = { ...selected }
      delete next[nodeId]
      setInteractiveNodes(next)
    }
  }, [selected, nodeById, setInteractiveNodes])

  // ── Clear handlers ──────────────────────────────────────────────────────────

  const handleClearSection = useCallback((treeType) => {
    const next = { ...selected }
    for (const n of treeData.nodes) {
      if (n.treeType === treeType && !n.alreadyGranted) delete next[n.id]
    }
    setInteractiveNodes(next)
  }, [selected, treeData.nodes, setInteractiveNodes])

  const handleClearAll = useCallback(() => {
    setInteractiveNodes(buildGrantedSeed(treeData))
  }, [treeData, setInteractiveNodes])

  // ── Point totals ────────────────────────────────────────────────────────────

  const classSpent = useMemo(() => sectionPoints('class', treeData.nodes, selected), [treeData.nodes, selected])
  const specSpent  = useMemo(() => sectionPoints('spec',  treeData.nodes, selected), [treeData.nodes, selected])
  const heroSpent  = useMemo(() => sectionPoints('hero',  treeData.nodes, selected), [treeData.nodes, selected])

  // ── Export ──────────────────────────────────────────────────────────────────

  const handleExport = useCallback(async () => {
    if (exportState !== 'idle' || !classNodes || invalidNodeIds.size > 0) return
    if (classSpent < budget.class || specSpent < budget.spec || heroSpent < budget.hero) return
    setExportState('copying')
    try {
      const activeSub = activeHeroSubtree(treeData.nodes, selected)
      // The hero gate node is the hero-tree choice: when hero talents are invested
      // the in-game format marks it selected with entryChosen = the active subtree
      // (0 = left, 1 = right). Include it so exports match the canonical encoding.
      const exportSelection = { ...selected }
      if (heroSpent > 0 && treeData.heroGateNodeId != null) {
        exportSelection[treeData.heroGateNodeId] = {
          pointsInvested: 1,
          entryChosen: activeSub === treeData.heroSubtrees.right.name ? 1 : 0,
        }
      }
      // Auto-granted nodes encode as selected-but-not-purchased. Class/spec grants
      // always apply; hero grants only for the active subtree (the inactive one's
      // granted root is not point-relevant and the game recomputes it on import).
      const grantedIds = new Set(
        treeData.nodes
          .filter((n) => n.alreadyGranted && (n.treeType !== 'hero' || n.heroSubtree === activeSub))
          .map((n) => n.id),
      )
      const buildStr = generateBuildString(exportSelection, specId, classNodes, grantedIds)
      await navigator.clipboard.writeText(buildStr)
      await addBuild(buildStr)
      setExportState('done')
    } catch {
      setExportState('error')
    } finally {
      // Delay hiding the interactive tree so "Copied & added!" is briefly visible
      setTimeout(() => {
        setExportState('idle')
        finishAddingBuild()
      }, 2000)
    }
  }, [exportState, selected, specId, classNodes, addBuild, invalidNodeIds.size,
      classSpent, specSpent, heroSpent, budget, treeData, finishAddingBuild])

  const pointsRemaining = useMemo(() => ({
    class: budget.class - classSpent,
    spec:  budget.spec  - specSpent,
    hero:  budget.hero  - heroSpent,
  }), [budget, classSpent, specSpent, heroSpent])

  const hasUserSelection = classSpent > 0 || specSpent > 0 || heroSpent > 0

  return (
    <div>
      {/* ── Toolbar ──────────────────────────────────────────────────────────── */}
      <div className="mb-4 px-1">
        <div className="flex items-center justify-between gap-6">
          {/* Left: per-section point bars with inline clear buttons */}
          <div className="flex gap-5">
            <SectionBar label="Class" spent={classSpent} max={budget.class} onClear={() => handleClearSection('class')} />
            <SectionBar label="Spec"  spent={specSpent}  max={budget.spec}  onClear={() => handleClearSection('spec')}  />
            <SectionBar label="Hero"  spent={heroSpent}  max={budget.hero}  onClear={() => handleClearSection('hero')}  />
          </div>

          {/* Right: hint + export + clear all */}
          <div className="flex items-center gap-3">
            <span className="text-wow-dim text-xs select-none">
              Left-click to spend · Right-click to refund
            </span>
            <ExportButton
              onClick={handleExport}
              state={exportState}
              invalidCount={invalidNodeIds.size}
              pointsRemaining={pointsRemaining}
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

      {/* ── Tree ─────────────────────────────────────────────────────────────── */}
      <TalentTree
        treeData={treeData}
        selectedNodes={selected}
        invalidNodeIds={invalidNodeIds}
        specId={specId}
        onNodeClick={handleClick}
        onNodeContextMenu={handleRightClick}
      />
    </div>
  )
}

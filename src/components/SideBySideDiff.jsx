import { useMemo } from 'react'
import TalentTree from './TalentTree'
import { computeDiff, selectionLabel } from '../lib/diff'

// ─── Diff summary panel ───────────────────────────────────────────────────────

function DiffRow({ node, selA, selB, type }) {
  if (type === 'a-only') {
    return (
      <li className="text-xs text-wow-muted">{selectionLabel(node, selA)}</li>
    )
  }
  if (type === 'b-only') {
    return (
      <li className="text-xs text-wow-muted">{selectionLabel(node, selB)}</li>
    )
  }

  // diff — rank or choice differs; show concise before/after
  if (node.type === 'choice') {
    const nameA = node.choices[selA.entryChosen]?.name ?? `option ${selA.entryChosen + 1}`
    const nameB = node.choices[selB.entryChosen]?.name ?? `option ${selB.entryChosen + 1}`
    return (
      <li className="text-xs">
        <span className="text-wow-text">A: {nameA}</span>
        <span className="mx-1.5 text-wow-dim">·</span>
        <span className="text-wow-text">B: {nameB}</span>
      </li>
    )
  }

  // rank diff (maxRanks > 1)
  return (
    <li className="text-xs">
      <span className="text-wow-muted">{node.name}</span>
      <span className="ml-2 text-wow-dim">
        A: <span className="text-wow-text">{selA.pointsInvested}/{node.maxRanks}</span>
        <span className="mx-1.5 text-wow-dim">·</span>
        B: <span className="text-wow-text">{selB.pointsInvested}/{node.maxRanks}</span>
      </span>
    </li>
  )
}

function SummarySection({ title, color, entries, type }) {
  if (entries.length === 0) return null

  const headerColors = {
    red:   'text-red-400 border-red-900/40',
    blue:  'text-blue-400 border-blue-900/40',
    amber: 'text-amber-400 border-amber-900/40',
  }

  return (
    <div className="min-w-0">
      <p className={`text-xs font-semibold uppercase tracking-wider mb-2 pb-1 border-b ${headerColors[color]}`}>
        {title}
        <span className="ml-1.5 font-normal opacity-70">({entries.length})</span>
      </p>
      <ul className="space-y-1">
        {entries.map((e) => (
          <DiffRow key={e.id} node={e.node} selA={e.selA} selB={e.selB} type={type} />
        ))}
      </ul>
    </div>
  )
}

function DiffSummary({ aOnly, bOnly, differing, labelA, labelB }) {
  const total = aOnly.length + bOnly.length + differing.length

  if (total === 0) {
    return (
      <div className="mt-6 px-4 py-3 rounded text-wow-muted text-xs" style={{ background: 'rgba(200,168,75,0.04)', border: '1px solid #3a2e1a' }}>
        Builds are identical.
      </div>
    )
  }

  return (
    <div className="mt-6 rounded p-4" style={{ background: 'rgba(200,168,75,0.03)', border: '1px solid #3a2e1a' }}>
      <p className="text-wow-gold-dark text-xs uppercase tracking-widest mb-4 select-none">
        Differences
        <span className="ml-1.5 normal-case tracking-normal text-wow-dim">({total})</span>
      </p>

      <div className="grid grid-cols-[1fr_1fr_1fr] gap-6">
        <SummarySection
          title={`Only in ${labelA}`}
          color="red"
          entries={aOnly}
          type="a-only"
        />
        <SummarySection
          title={`Only in ${labelB}`}
          color="blue"
          entries={bOnly}
          type="b-only"
        />
        <SummarySection
          title="Different rank or choice"
          color="amber"
          entries={differing}
          type="diff"
        />
      </div>
    </div>
  )
}

// ─── Build label ──────────────────────────────────────────────────────────────

function BuildLabel({ label, color }) {
  const dot = color === 'A' ? 'bg-red-500' : 'bg-blue-500'
  return (
    <div className="flex items-center gap-2 mb-2 select-none">
      <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
      <span className="text-wow-muted text-sm font-medium">{label}</span>
    </div>
  )
}

// ─── Main export ──────────────────────────────────────────────────────────────

export default function SideBySideDiff({
  treeData,
  buildA,
  buildB,
  labelA = 'Build A',
  labelB = 'Build B',
}) {
  const { highlights, aOnly, bOnly, differing } = useMemo(
    () => computeDiff(buildA.nodes, buildB.nodes, treeData.nodes),
    [buildA, buildB, treeData],
  )

  return (
    <div>
      {/* ── Two trees: side by side on wide screens, stacked on narrow ───────── */}
      <div className="flex flex-col gap-10 pb-2 xl:flex-row xl:items-start">
        <div>
          <BuildLabel label={labelA} color="A" />
          <TalentTree
            treeData={treeData}
            selectedNodes={buildA.nodes}
            highlights={highlights}
          />
        </div>

        {/* Divider: horizontal between stacked builds, vertical when side by side */}
        <div className="h-px w-full bg-wow-dim xl:h-auto xl:w-px xl:self-stretch" />

        <div>
          <BuildLabel label={labelB} color="B" />
          <TalentTree
            treeData={treeData}
            selectedNodes={buildB.nodes}
            highlights={highlights}
          />
        </div>
      </div>

      {/* ── Diff summary ────────────────────────────────────────────────────── */}
      <DiffSummary
        aOnly={aOnly}
        bOnly={bOnly}
        differing={differing}
        labelA={labelA}
        labelB={labelB}
      />
    </div>
  )
}

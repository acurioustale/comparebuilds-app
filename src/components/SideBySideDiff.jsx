import { useMemo } from 'react'
import { TreePanel } from './TalentTree'
import { computeDiff, selectionLabel } from '../lib/diff'
import { byId } from './treeLayout'
import { activeHeroSubtree } from '../lib/spendRules'

// ─── Diff summary panel ───────────────────────────────────────────────────────

function DiffRow({ node, selA, selB, type }) {
  if (type === 'a-only') {
    return <li className="text-xs text-wow-muted">{selectionLabel(node, selA)}</li>
  }
  if (type === 'b-only') {
    return <li className="text-xs text-wow-muted">{selectionLabel(node, selB)}</li>
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
        <SummarySection title={`Only in ${labelA}`} color="red"   entries={aOnly}     type="a-only" />
        <SummarySection title={`Only in ${labelB}`} color="blue"  entries={bOnly}     type="b-only" />
        <SummarySection title="Different rank or choice" color="amber" entries={differing} type="diff" />
      </div>
    </div>
  )
}

// ─── Paired section pieces ────────────────────────────────────────────────────

// Centered section heading with flanking gold rules.
function SectionDivider({ children }) {
  return (
    <div className="flex items-center gap-2 mb-3 select-none">
      <div className="flex-1 h-px" style={{ background: 'linear-gradient(to right, transparent, rgba(200,168,75,0.55))' }} />
      <span className="text-wow-gold text-xs uppercase tracking-[0.18em] shrink-0">{children}</span>
      <div className="flex-1 h-px" style={{ background: 'linear-gradient(to left, transparent, rgba(200,168,75,0.55))' }} />
    </div>
  )
}

// Small coloured build tag above each panel (red = A, blue = B).
function BuildTag({ label, color }) {
  return (
    <div className="flex items-center gap-1.5 mb-1.5 select-none">
      <span className={`w-2 h-2 rounded-full shrink-0 ${color === 'A' ? 'bg-red-500' : 'bg-blue-500'}`} />
      <span className="text-wow-muted text-xs">{label}</span>
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
  // Responsive coordination: 'row' | 'stacked' from the FitToWidth coordinator, so
  // reflow lines up with the zoom scale.
  layout = 'row',
}) {
  const { highlights, aOnly, bOnly, differing } = useMemo(
    () => computeDiff(buildA.nodes, buildB.nodes, treeData.nodes),
    [buildA, buildB, treeData],
  )

  const nodeById = useMemo(() => byId(treeData.nodes), [treeData])

  const classNodes = useMemo(() => treeData.nodes.filter((n) => n.treeType === 'class'), [treeData])
  const specNodes  = useMemo(() => treeData.nodes.filter((n) => n.treeType === 'spec'),  [treeData])
  const leftName  = treeData.heroSubtrees.left.name
  const rightName = treeData.heroSubtrees.right.name
  const leftNodes  = useMemo(() => treeData.nodes.filter((n) => n.heroSubtree === leftName),  [treeData, leftName])
  const rightNodes = useMemo(() => treeData.nodes.filter((n) => n.heroSubtree === rightName), [treeData, rightName])

  const activeA = activeHeroSubtree(treeData.nodes, buildA.nodes)
  const activeB = activeHeroSubtree(treeData.nodes, buildB.nodes)

  // One build's class/spec section panel.
  const panel = (nodes, build, checkpoints = []) => (
    <TreePanel
      nodes={nodes}
      selectedNodes={build.nodes}
      nodeById={nodeById}
      highlights={highlights}
      checkpoints={checkpoints}
    />
  )

  // One build's hero block (both subtrees side by side, inactive one locked).
  const heroBlock = (build, active) => (
    <div className="flex items-start">
      <TreePanel nodes={leftNodes}  selectedNodes={build.nodes} nodeById={nodeById} highlights={highlights} heroLocked={active !== null && active !== leftName} />
      <div className="self-stretch w-px bg-wow-dim mx-3" />
      <TreePanel nodes={rightNodes} selectedNodes={build.nodes} nodeById={nodeById} highlights={highlights} heroLocked={active !== null && active !== rightName} />
    </div>
  )

  // Section row layout: builds side by side when 'row', stacked per section when
  // narrow — driven by the FitToWidth coordinator so reflow matches the zoom scale.
  const pairRowClass = layout === 'row'
    ? 'flex flex-row items-start justify-center gap-8'
    : 'flex flex-col items-center gap-6'
  // Build tags are one-time column headers when paired (first row only) and repeat
  // on every section when stacked, so each panel stays identifiable.
  const tagWrapClass = (tagsAlways) =>
    tagsAlways ? undefined : layout === 'row' ? 'hidden' : undefined

  const Row = ({ label, a, b, tagsAlways = false }) => (
    <div>
      <SectionDivider>{label}</SectionDivider>
      <div className={pairRowClass}>
        <div>
          <div className={tagWrapClass(tagsAlways)}><BuildTag label={labelA} color="A" /></div>
          {a}
        </div>
        <div>
          <div className={tagWrapClass(tagsAlways)}><BuildTag label={labelB} color="B" /></div>
          {b}
        </div>
      </div>
    </div>
  )

  return (
    <div>
      <div className="flex flex-col gap-8 pb-2">
        <Row
          label="Class"
          tagsAlways
          a={panel(classNodes, buildA, treeData.checkpoints?.class ?? [])}
          b={panel(classNodes, buildB, treeData.checkpoints?.class ?? [])}
        />
        <Row
          label="Spec"
          a={panel(specNodes, buildA, treeData.checkpoints?.spec ?? [])}
          b={panel(specNodes, buildB, treeData.checkpoints?.spec ?? [])}
        />
        <Row
          label={`${leftName} ✦ ${rightName}`}
          a={heroBlock(buildA, activeA)}
          b={heroBlock(buildB, activeB)}
        />
      </div>

      <DiffSummary aOnly={aOnly} bOnly={bOnly} differing={differing} labelA={labelA} labelB={labelB} />
    </div>
  )
}

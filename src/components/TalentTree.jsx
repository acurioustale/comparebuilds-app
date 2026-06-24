import { useMemo, useId } from 'react'
import Tippy from '@tippyjs/react'
import 'tippy.js/dist/tippy.css'
import { zamimg } from '../lib/zamimg'
import { activeHeroSubtree } from '../lib/spendRules'
import { CELL, ICON, CHOICE_ICON, APEX_ICON, CHOICE_GAP, PAD, byId, panelBounds, panelEdges, sectionRowClass, dividerClass } from './treeLayout'

// Box-shadow strings for diff highlight glows
const HL_SHADOW = {
  'a-only': '0 0 0 2px rgba(255,68,68,0.85), 0 0 12px rgba(255,68,68,0.6), 0 0 28px rgba(255,68,68,0.3)',
  'b-only': '0 0 0 2px rgba(68,136,255,0.85), 0 0 12px rgba(68,136,255,0.6), 0 0 28px rgba(68,136,255,0.3)',
  'diff':   '0 0 0 2px rgba(245,158,11,0.9),  0 0 12px rgba(245,158,11,0.7), 0 0 28px rgba(245,158,11,0.4)',
}
const GOLD_GLOW    = '0 0 8px rgba(200,168,75,0.55), inset 0 0 6px rgba(200,168,75,0.12)'
const INVALID_GLOW = '0 0 0 2px rgba(200,50,50,0.9), 0 0 12px rgba(200,50,50,0.5)'

function nodeShadow(isSelected, highlight, invalid) {
  const parts = []
  if (isSelected) parts.push(invalid ? INVALID_GLOW : GOLD_GLOW)
  if (highlight)  parts.push(HL_SHADOW[highlight])
  return parts.length ? parts.join(', ') : undefined
}

// ─── Tooltip content ──────────────────────────────────────────────────────────

function NodeTooltip({ node, entryChosen, pointsInvested = 0 }) {
  if (node.type === 'choice') {
    return (
      <div className="space-y-2 py-0.5" style={{ maxWidth: 260 }}>
        {node.choices.map((ch, i) => (
          <div
            key={i}
            style={{ opacity: entryChosen === null ? 0.85 : entryChosen === i ? 1 : 0.4 }}
          >
            <p className="font-semibold text-xs text-wow-gold">{ch.name}</p>
            {ch.description && (
              <p
                className="text-xs text-wow-muted mt-0.5 leading-snug"
                dangerouslySetInnerHTML={{ __html: ch.description }}
              />
            )}
          </div>
        ))}
      </div>
    )
  }

  if (node.type === 'apex') {
    let cumulative = 0
    return (
      <div className="py-0.5" style={{ maxWidth: 280 }}>
        <p className="font-semibold text-xs text-wow-gold mb-1">{node.name}</p>
        {node.ranks?.map((rank, i) => {
          const thisStart = cumulative
          cumulative += rank.maxRanks
          const reached = (pointsInvested ?? 0) >= cumulative
          const inProgress = !reached && (pointsInvested ?? 0) > thisStart
          return (
            <div key={i} className="mt-1.5" style={{ opacity: reached || inProgress ? 1 : 0.4 }}>
              {node.levels?.[i] != null && (
                <p className="text-[10px] text-wow-dim mb-0.5">Level {node.levels[i]}</p>
              )}
              {rank.description && (
                <p
                  className="text-xs text-wow-muted leading-snug"
                  dangerouslySetInnerHTML={{ __html: rank.description }}
                />
              )}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="py-0.5" style={{ maxWidth: 260 }}>
      <p className="font-semibold text-xs text-wow-gold">{node.name}</p>
      {node.description && (
        <p
          className="text-xs text-wow-muted mt-0.5 leading-snug"
          dangerouslySetInnerHTML={{ __html: node.description }}
        />
      )}
      {node.alreadyGranted && (
        <p className="text-xs text-wow-dim mt-1 italic">Passive — always active</p>
      )}
    </div>
  )
}

// ─── Individual talent node ───────────────────────────────────────────────────

function TalentNode({
  node, px, py, sel, alreadyGranted,
  highlight = null, locked = false, invalid = false,
  onNodeClick = null, onNodeContextMenu = null,
}) {
  const isSelected     = sel !== undefined || alreadyGranted
  const pointsInvested = sel?.pointsInvested ?? (alreadyGranted ? node.maxRanks : 0)
  const entryChosen    = sel?.entryChosen ?? null

  const tip           = <NodeTooltip node={node} entryChosen={entryChosen} pointsInvested={pointsInvested} />
  const hasHandlers   = onNodeClick || onNodeContextMenu
  const onContextMenu = hasHandlers
    ? (e) => { e.preventDefault(); onNodeContextMenu?.(node.id) }
    : undefined

  // Keyboard accessibility: only the interactive tree wires onNodeClick. Static
  // comparison/heatmap views stay non-focusable (their textual diff/legend is the
  // screen-reader path) so we don't add hundreds of tab stops to a read-only grid.
  const interactive = !!onNodeClick
  const ariaLabel = alreadyGranted
    ? `${node.name} — passive, always active`
    : `${node.name} — ${pointsInvested > 0 ? 'selected' : 'not selected'}` +
      (node.maxRanks > 1 ? `, ${pointsInvested} of ${node.maxRanks} points` : '')
  // Enter/Space spend a point; Delete/Backspace refund (keyboard analogue of right-click).
  const onKeyDown = interactive
    ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onNodeClick(node.id)
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault()
          onNodeContextMenu?.(node.id)
        }
      }
    : undefined

  const nodeOpacity = isSelected ? 1 : highlight ? 0.55 : locked ? 0.16 : 0.42
  const nodeBorder  = isSelected
    ? (invalid ? 'rgba(200,60,60,0.85)' : '#c8a84b')
    : locked ? '#1a1208' : '#2d2010'
  const nodeCursor  = hasHandlers ? ((locked && !isSelected) ? 'not-allowed' : 'pointer') : 'default'

  // ── Choice node ─────────────────────────────────────────────────────────────
  if (node.type === 'choice') {
    const totalW = CHOICE_ICON * 2 + CHOICE_GAP
    return (
      <Tippy content={tip} placement="top" delay={[300, 0]}>
        <div
          onContextMenu={onContextMenu}
          style={{
            position: 'absolute',
            left: px - totalW / 2,
            top: py - CHOICE_ICON / 2,
            display: 'flex',
            gap: CHOICE_GAP,
            cursor: nodeCursor,
            boxShadow: nodeShadow(isSelected, highlight, invalid),
            borderRadius: 5,
            transition: 'opacity 0.2s',
          }}
        >
          {node.choices.map((ch, i) => {
            const chosen   = isSelected && entryChosen === i
            const unchosen = isSelected && entryChosen !== null && entryChosen !== i
            return (
              <div
                key={i}
                onClick={onNodeClick ? () => onNodeClick(node.id, i) : undefined}
                className={interactive ? 'tnode' : undefined}
                role={interactive ? 'button' : undefined}
                tabIndex={interactive ? 0 : undefined}
                aria-pressed={interactive ? chosen : undefined}
                aria-label={interactive ? `${ch.name}${chosen ? ' — selected' : ''}` : undefined}
                onKeyDown={interactive ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNodeClick(node.id, i) }
                  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); onNodeContextMenu?.(node.id) }
                } : undefined}
                style={{
                  position: 'relative',
                  width: CHOICE_ICON,
                  height: CHOICE_ICON,
                  borderRadius: 3,
                  overflow: 'hidden',
                  border: `1.5px solid ${chosen ? (invalid ? 'rgba(200,60,60,0.85)' : '#c8a84b') : nodeBorder}`,
                  opacity: !isSelected ? nodeOpacity : unchosen ? 0.25 : 1,
                  flexShrink: 0,
                  transition: 'opacity 0.2s',
                  zIndex: 1,
                }}
              >
                <img
                  src={zamimg(ch.icon)}
                  width={CHOICE_ICON}
                  height={CHOICE_ICON}
                  alt=""
                  draggable={false}
                  loading="lazy"
                  decoding="async"
                  style={{ display: 'block' }}
                />
              </div>
            )
          })}

          {invalid && (
            <div style={{
              position: 'absolute',
              left: 0, top: 0,
              width: totalW, height: CHOICE_ICON,
              background: 'rgba(180,30,30,0.4)',
              borderRadius: 4,
              pointerEvents: 'none',
              zIndex: 3,
            }} />
          )}
        </div>
      </Tippy>
    )
  }

  // ── Apex node ────────────────────────────────────────────────────────────────
  if (node.type === 'apex') {
    const S = APEX_ICON
    const showApexRank = isSelected && node.maxRanks > 1
    return (
      <Tippy content={tip} placement="top" delay={[300, 0]}>
        <div
          onClick={hasHandlers ? () => onNodeClick?.(node.id) : undefined}
          onContextMenu={onContextMenu}
          className={interactive ? 'tnode' : undefined}
          role={interactive ? 'button' : undefined}
          tabIndex={interactive ? 0 : undefined}
          aria-pressed={interactive ? isSelected : undefined}
          aria-label={interactive ? ariaLabel : undefined}
          onKeyDown={onKeyDown}
          style={{
            position: 'absolute',
            left: px - S / 2,
            top: py - S / 2,
            cursor: nodeCursor,
          }}
        >
          <div
            style={{
              position: 'relative',
              width: S,
              height: S,
              borderRadius: '50%',
              overflow: 'hidden',
              border: `2px solid ${nodeBorder}`,
              opacity: nodeOpacity,
              boxShadow: nodeShadow(isSelected, highlight, invalid),
              transition: 'opacity 0.2s',
            }}
          >
            <img
              src={zamimg(node.icon)}
              width={S}
              height={S}
              alt=""
              draggable={false}
              loading="lazy"
              decoding="async"
              style={{ display: 'block' }}
            />
            {invalid && (
              <div style={{
                position: 'absolute',
                left: 0, top: 0,
                width: S, height: S,
                background: 'rgba(180,30,30,0.4)',
                borderRadius: '50%',
                pointerEvents: 'none',
              }} />
            )}
          </div>
          {showApexRank && (
            <div style={{
              position: 'absolute',
              bottom: -1,
              right: -1,
              fontSize: 8,
              lineHeight: 1,
              background: 'rgba(0,0,0,0.92)',
              color: pointsInvested >= node.maxRanks ? '#c8a84b' : '#9a8a6a',
              padding: '1px 3px',
              borderTopLeftRadius: 3,
              fontVariantNumeric: 'tabular-nums',
              fontFamily: 'ui-monospace,monospace',
              pointerEvents: 'none',
              zIndex: 3,
            }}>
              {pointsInvested}/{node.maxRanks}
            </div>
          )}
        </div>
      </Tippy>
    )
  }

  // ── Round / square node ──────────────────────────────────────────────────────
  const S       = ICON
  const isRound = node.type === 'round'
  const showRank = node.maxRanks > 1 && isSelected
  const radius   = isRound ? '50%' : 4

  return (
    <Tippy content={tip} placement="top" delay={[300, 0]}>
      <div
        onClick={hasHandlers ? () => onNodeClick?.(node.id) : undefined}
        onContextMenu={onContextMenu}
        className={interactive ? 'tnode' : undefined}
        role={interactive ? 'button' : undefined}
        tabIndex={interactive ? 0 : undefined}
        aria-pressed={interactive ? isSelected : undefined}
        aria-label={interactive ? ariaLabel : undefined}
        onKeyDown={onKeyDown}
        style={{
          position: 'absolute',
          left: px - S / 2,
          top: py - S / 2,
          cursor: nodeCursor,
        }}
      >
        <div
          style={{
            position: 'relative',
            width: S,
            height: S,
            borderRadius: radius,
            overflow: 'hidden',
            border: `1.5px solid ${nodeBorder}`,
            opacity: nodeOpacity,
            boxShadow: nodeShadow(isSelected, highlight, invalid),
            transition: 'opacity 0.2s',
          }}
        >
          <img
            src={zamimg(node.icon)}
            width={S}
            height={S}
            alt=""
            draggable={false}
            loading="lazy"
            decoding="async"
            style={{ display: 'block' }}
          />
          {invalid && (
            <div style={{
              position: 'absolute',
              left: 0, top: 0,
              width: S, height: S,
              background: 'rgba(180,30,30,0.4)',
              borderRadius: radius,
              pointerEvents: 'none',
            }} />
          )}
        </div>

        {showRank && (
          <div
            style={{
              position: 'absolute',
              bottom: -1,
              right: -1,
              fontSize: 8,
              lineHeight: 1,
              background: 'rgba(0,0,0,0.92)',
              color: pointsInvested >= node.maxRanks ? '#c8a84b' : '#9a8a6a',
              padding: '1px 3px',
              borderTopLeftRadius: 3,
              fontVariantNumeric: 'tabular-nums',
              fontFamily: 'ui-monospace,monospace',
              pointerEvents: 'none',
              zIndex: 3,
            }}
          >
            {pointsInvested}/{node.maxRanks}
          </div>
        )}
      </div>
    </Tippy>
  )
}

// ─── Hero locked overlay ──────────────────────────────────────────────────────

function HeroLockedOverlay() {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 10,
        background: 'rgba(5,4,10,0.72)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'all',
        borderRadius: 4,
      }}
    >
      <span
        style={{
          color: '#6a5a3a',
          fontSize: 10,
          fontFamily: "'FrizQuadrata', 'Palatino Linotype', serif",
          letterSpacing: '0.05em',
          textAlign: 'center',
          padding: '4px 8px',
          border: '1px solid rgba(100,80,40,0.3)',
          borderRadius: 6,
          background: 'rgba(0,0,0,0.4)',
          userSelect: 'none',
        }}
      >
        Choose one hero talent path
      </span>
    </div>
  )
}

// ─── Gate divider ─────────────────────────────────────────────────────────────

function GateDivider({ gate, minY, W }) {
  const y = (gate.row - 0.5 - minY) * CELL + PAD
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: y - 8,
        width: W,
        height: 16,
        display: 'flex',
        alignItems: 'center',
        pointerEvents: 'none',
        zIndex: 5,
      }}
    >
      <div style={{ flex: 1, height: 1, background: 'rgba(200,168,75,0.18)' }} />
      <span
        style={{
          padding: '2px 8px',
          background: '#0a0a12',
          border: '1px solid rgba(200,168,75,0.28)',
          borderRadius: 10,
          color: '#c8a84b',
          fontSize: 9,
          lineHeight: 1.6,
          whiteSpace: 'nowrap',
          fontFamily: "'FrizQuadrata', 'Palatino Linotype', serif",
          letterSpacing: '0.04em',
        }}
      >
        {gate.points} points to unlock
      </span>
      <div style={{ flex: 1, height: 1, background: 'rgba(200,168,75,0.18)' }} />
    </div>
  )
}

// ─── Tree panel ───────────────────────────────────────────────────────────────

export function TreePanel({
  nodes, selectedNodes, nodeById,
  highlights = {}, checkpoints = [],
  invalidNodeIds = null, heroLocked = false,
  onNodeClick = null, onNodeContextMenu = null,
  onClear = null, clearDisabled = false,
}) {
  const rawId  = useId()
  const gradId = `tl-${rawId.replace(/:/g, '')}`

  const { minX, minY, W, H } = useMemo(() => panelBounds(nodes), [nodes])

  const spentPoints = useMemo(
    () => nodes.reduce((sum, n) => n.alreadyGranted ? sum : sum + (selectedNodes[n.id]?.pointsInvested ?? 0), 0),
    [nodes, selectedNodes],
  )

  const unmetGates = useMemo(
    () => checkpoints.filter((g) => spentPoints < g.points),
    [checkpoints, spentPoints],
  )

  const lockedFromRow = unmetGates.length > 0
    ? Math.min(...unmetGates.map((g) => g.row))
    : Infinity

  const edges = useMemo(() => panelEdges(nodes, nodeById, minX, minY), [nodes, nodeById, minX, minY])

  return (
    <div
      className="wow-subpanel"
      style={{
        position: 'relative',
        width: W,
        // Reserve a strip below the grid for the in-panel Clear so it never
        // overlaps a corner node (some class trees reach the bottom-right).
        height: onClear ? H + 24 : H,
        flexShrink: 0,
      }}
    >
      <svg
        width={W}
        height={H}
        style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', overflow: 'visible' }}
      >
        <defs>
          <linearGradient id={gradId} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={H}>
            <stop offset="0%"   stopColor="#3a2a0a" />
            <stop offset="100%" stopColor="#c8a84b" />
          </linearGradient>
        </defs>
        {edges.map((e, i) => {
          const fromSel = !!selectedNodes[e.fromId] || nodeById[e.fromId]?.alreadyGranted
          const toSel   = !!selectedNodes[e.toId]   || nodeById[e.toId]?.alreadyGranted
          const lit     = fromSel && toSel
          return (
            <line
              key={i}
              x1={e.x1} y1={e.y1}
              x2={e.x2} y2={e.y2}
              stroke={lit ? `url(#${gradId})` : '#2a2a2a'}
              strokeWidth={lit ? 2 : 1}
            />
          )
        })}
      </svg>

      {nodes.map((node) => (
        <TalentNode
          key={node.id}
          node={node}
          px={(node.posX - minX) * CELL + PAD}
          py={(node.posY - minY) * CELL + PAD}
          sel={selectedNodes[node.id]}
          alreadyGranted={node.alreadyGranted}
          highlight={highlights[node.id] ?? null}
          locked={heroLocked || (!node.alreadyGranted && node.posY >= lockedFromRow)}
          invalid={!!(invalidNodeIds?.has(node.id))}
          onNodeClick={heroLocked ? null : onNodeClick}
          onNodeContextMenu={heroLocked ? null : onNodeContextMenu}
        />
      ))}

      {unmetGates.map((gate) => (
        <GateDivider key={gate.points} gate={gate} minY={minY} W={W} />
      ))}

      {heroLocked && <HeroLockedOverlay />}

      {/* In-panel Clear, anchored to the lower-right corner. zIndex sits above the
          hero lock overlay so it stays visible (disabled) on the inactive subtree. */}
      {onClear && (
        <button
          onClick={onClear}
          disabled={clearDisabled}
          className="wow-btn text-[10px] px-2 py-0.5 rounded select-none"
          style={{ position: 'absolute', right: 8, bottom: 5, zIndex: 11 }}
        >
          Clear
        </button>
      )}
    </div>
  )
}

// ─── Section label ────────────────────────────────────────────────────────────

// Counter shown inline after a section title, e.g. "12/34" (green when maxed).
function SectionCounter({ spent, max }) {
  const full = max > 0 && spent >= max
  return (
    <span className={`font-mono tabular-nums text-[11px] tracking-normal ${full ? 'text-green-400' : 'text-wow-text'}`}>
      {spent}<span className="text-wow-muted">/{max}</span>
    </span>
  )
}

function PanelLabel({ children, spent, max }) {
  const showCounter = spent != null && max != null
  return (
    <div className="mb-2 select-none">
      <div className="flex items-center gap-2">
        <div style={{ flex: 1, height: 1, background: 'linear-gradient(to right, transparent, rgba(200,168,75,0.55))' }} />
        <span className="text-wow-gold text-xs uppercase tracking-[0.2em] shrink-0 flex items-baseline gap-2">
          <span>{children}</span>
          {showCounter && <SectionCounter spent={spent} max={max} />}
        </span>
        <div style={{ flex: 1, height: 1, background: 'linear-gradient(to left, transparent, rgba(200,168,75,0.55))' }} />
      </div>
    </div>
  )
}

// ─── Main export ──────────────────────────────────────────────────────────────

export default function TalentTree({
  treeData, selectedNodes = {}, highlights = {},
  invalidNodeIds = null,
  onNodeClick = null, onNodeContextMenu = null,
  // Interactive-only: per-section spent totals and a clear handler. When present,
  // each panel header shows its counter and each panel a corner Clear button.
  // Omitted by the read-only diff/heatmap/single views.
  sectionSpent = null, onClearSection = null,
  // Responsive coordination: when the parent (FitToWidth) drives layout per-build,
  // it passes 'row' or 'stacked' explicitly. Left null elsewhere (interactive
  // mode), where stacking falls back to the global 2xl media query.
  layout = null,
}) {
  const nodeById = useMemo(() => byId(treeData.nodes), [treeData])
  const budget = treeData.pointBudget

  const classNodes = useMemo(() => treeData.nodes.filter((n) => n.treeType === 'class'), [treeData])
  const specNodes  = useMemo(() => treeData.nodes.filter((n) => n.treeType === 'spec'),  [treeData])
  const leftNodes  = useMemo(
    () => treeData.nodes.filter((n) => n.heroSubtree === treeData.heroSubtrees.left.name),
    [treeData],
  )
  const rightNodes = useMemo(
    () => treeData.nodes.filter((n) => n.heroSubtree === treeData.heroSubtrees.right.name),
    [treeData],
  )

  const activeHero = useMemo(
    () => activeHeroSubtree(treeData.nodes, selectedNodes),
    [treeData.nodes, selectedNodes],
  )

  const leftLocked  = activeHero !== null && activeHero !== treeData.heroSubtrees.left.name
  const rightLocked = activeHero !== null && activeHero !== treeData.heroSubtrees.right.name

  return (
    <div className="overflow-x-auto pb-1">
      <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 16, minWidth: 'max-content' }}>

        {/* ── Class + Spec panels (stack when narrow, side by side when wide) ── */}
        <div className={sectionRowClass(layout)}>
          <div>
            <PanelLabel
              spent={sectionSpent?.class}
              max={sectionSpent ? budget?.class : undefined}
            >
              Class
            </PanelLabel>
            <TreePanel
              nodes={classNodes}
              selectedNodes={selectedNodes}
              nodeById={nodeById}
              highlights={highlights}
              checkpoints={treeData.checkpoints?.class ?? []}
              invalidNodeIds={invalidNodeIds}
              onNodeClick={onNodeClick}
              onNodeContextMenu={onNodeContextMenu}
              onClear={onClearSection ? () => onClearSection('class') : null}
              clearDisabled={!sectionSpent?.class}
            />
          </div>

          <div className={dividerClass(layout, 'mt-5')} />

          <div>
            <PanelLabel
              spent={sectionSpent?.spec}
              max={sectionSpent ? budget?.spec : undefined}
            >
              Spec
            </PanelLabel>
            <TreePanel
              nodes={specNodes}
              selectedNodes={selectedNodes}
              nodeById={nodeById}
              highlights={highlights}
              checkpoints={treeData.checkpoints?.spec ?? []}
              invalidNodeIds={invalidNodeIds}
              onNodeClick={onNodeClick}
              onNodeContextMenu={onNodeContextMenu}
              onClear={onClearSection ? () => onClearSection('spec') : null}
              clearDisabled={!sectionSpent?.spec}
            />
          </div>
        </div>

        {/* ── Hero subtrees ────────────────────────────────────────────────── */}
        <div>
          {/* Section header row */}
          <div className="mb-2">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, height: 1, background: 'linear-gradient(to right, transparent, rgba(200,168,75,0.55))' }} />
              <span className="text-wow-gold text-xs uppercase tracking-[0.15em] select-none">
                {treeData.heroSubtrees.left.name}
              </span>
              <span className="text-wow-gold-dark select-none" style={{ fontSize: 9 }}>✦</span>
              <span className="text-wow-gold text-xs uppercase tracking-[0.15em] select-none">
                {treeData.heroSubtrees.right.name}
              </span>
              {sectionSpent?.hero != null && <SectionCounter spent={sectionSpent.hero} max={budget?.hero ?? 0} />}
              <div style={{ flex: 1, height: 1, background: 'linear-gradient(to left, transparent, rgba(200,168,75,0.55))' }} />
            </div>
          </div>

          <div className={sectionRowClass(layout, true)}>
            <TreePanel
              nodes={leftNodes}
              selectedNodes={selectedNodes}
              nodeById={nodeById}
              highlights={highlights}
              invalidNodeIds={invalidNodeIds}
              heroLocked={leftLocked}
              onNodeClick={onNodeClick}
              onNodeContextMenu={onNodeContextMenu}
              onClear={onClearSection ? () => onClearSection('hero') : null}
              clearDisabled={activeHero !== treeData.heroSubtrees.left.name}
            />
            <div className={dividerClass(layout)} />
            <TreePanel
              nodes={rightNodes}
              selectedNodes={selectedNodes}
              nodeById={nodeById}
              highlights={highlights}
              invalidNodeIds={invalidNodeIds}
              heroLocked={rightLocked}
              onNodeClick={onNodeClick}
              onNodeContextMenu={onNodeContextMenu}
              onClear={onClearSection ? () => onClearSection('hero') : null}
              clearDisabled={activeHero !== treeData.heroSubtrees.right.name}
            />
          </div>
        </div>

      </div>
    </div>
  )
}

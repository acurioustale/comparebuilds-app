import { useMemo } from 'react'
import Tippy from '@tippyjs/react'
import 'tippy.js/dist/tippy.css'
import { zamimg } from '../lib/zamimg'
import { rarityTier, computeStats, computeLegendTiers } from '../lib/heatmap'
import { CELL, ICON, CHOICE_ICON, APEX_ICON, CHOICE_GAP, PAD, byId, panelBounds, panelEdges } from './treeLayout'

// Dot indicators for choice nodes (one dot per build)
const DOT = 5
const DOT_GAP = 1

// ─── Rarity scale ─────────────────────────────────────────────────────────────

const RARITY = {
  legendary: { color: '#ff8000', glow: 'rgba(255,128,0,0.5)',   label: 'Legendary' },
  epic:      { color: '#a335ee', glow: 'rgba(163,53,238,0.5)',  label: 'Epic'      },
  rare:      { color: '#0070dd', glow: 'rgba(0,112,221,0.5)',   label: 'Rare'      },
  uncommon:  { color: '#1eff00', glow: 'rgba(30,255,0,0.5)',    label: 'Uncommon'  },
  poor:      { color: '#9d9d9d', glow: 'rgba(157,157,157,0.3)', label: 'Poor'      },
}

// Per-build dot/indicator colors (up to 5 builds)
const BUILD_COLORS = ['#facc15', '#38bdf8', '#f472b6', '#4ade80', '#fb923c']

// ─── Legend ───────────────────────────────────────────────────────────────────

function RarityLegend({ n }) {
  const tiers = useMemo(() => computeLegendTiers(n), [n])

  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 mb-4">
      {tiers.map(({ tier, rangeLabel }) => {
        const r = RARITY[tier]
        return (
          <div key={tier} className="flex items-center gap-1.5">
            <span
              style={{
                display: 'inline-block',
                width: 10,
                height: 10,
                borderRadius: 2,
                background: r.color,
                boxShadow: `0 0 4px ${r.glow}`,
                flexShrink: 0,
              }}
            />
            <span className="text-xs text-wow-muted">
              {r.label}
              <span className="ml-1 text-wow-dim">{rangeLabel}</span>
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ─── Individual heatmap node ──────────────────────────────────────────────────

function HeatmapNode({ node, px, py, stat, totalBuilds, alreadyGranted }) {
  const count = stat?.count ?? 0
  const choiceVotes = stat?.choiceVotes ?? []
  const tier = rarityTier(count, totalBuilds)
  const rarity = RARITY[tier]

  // ── Choice node ───────────────────────────────────────────────────────────
  if (node.type === 'choice') {
    const totalW = CHOICE_ICON * 2 + CHOICE_GAP

    const tipContent = (
      <div className="space-y-1.5 py-0.5" style={{ maxWidth: 240 }}>
        {node.choices.map((ch, i) => {
          const votes = choiceVotes.filter((v) => v === i).length
          return (
            <div key={i}>
              <p className="font-semibold text-xs text-wow-gold">{ch.name}</p>
              <p className="text-xs text-wow-muted">{votes} / {totalBuilds} builds</p>
            </div>
          )
        })}
      </div>
    )

    return (
      <div
        style={{
          position: 'absolute',
          left: px - totalW / 2,
          top: py - CHOICE_ICON / 2,
        }}
      >
        {/* Icons + rarity ring — Tippy wraps only this area */}
        <Tippy content={tipContent} placement="top" delay={[300, 0]}>
          <div style={{ position: 'relative', cursor: 'default' }}>
            <div
              style={{
                position: 'absolute',
                inset: -3,
                borderRadius: 6,
                border: `2px solid ${rarity.color}`,
                boxShadow: `0 0 7px ${rarity.glow}`,
                pointerEvents: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: CHOICE_GAP }}>
              {node.choices.map((ch, i) => {
                const anyBuildChoseThis = choiceVotes.some((v) => v === i)
                return (
                  <div
                    key={i}
                    style={{
                      width: CHOICE_ICON,
                      height: CHOICE_ICON,
                      borderRadius: 3,
                      overflow: 'hidden',
                      border: `1.5px solid ${rarity.color}`,
                      opacity: count === 0 ? 0.12 : anyBuildChoseThis ? 1 : 0.15,
                      flexShrink: 0,
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
            </div>
          </div>
        </Tippy>

        {/* Per-build choice dots — purely visual, no pointer events */}
        {count > 0 && (
          <div
            style={{
              position: 'absolute',
              top: CHOICE_ICON + 3,
              left: 0,
              width: totalW,
              pointerEvents: 'none',
            }}
          >
            {choiceVotes.map((vote, bi) => {
              if (vote === null) return null
              const iconCenterX = vote === 0
                ? CHOICE_ICON / 2
                : CHOICE_ICON + CHOICE_GAP + CHOICE_ICON / 2
              const sameOptionBefore = choiceVotes
                .slice(0, bi)
                .filter((v) => v === vote).length
              return (
                <div
                  key={bi}
                  style={{
                    position: 'absolute',
                    left: iconCenterX - DOT / 2,
                    top: sameOptionBefore * (DOT + DOT_GAP),
                    width: DOT,
                    height: DOT,
                    borderRadius: '50%',
                    background: BUILD_COLORS[bi] ?? '#fff',
                  }}
                />
              )
            })}
          </div>
        )}
      </div>
    )
  }

  // ── Apex node ─────────────────────────────────────────────────────────────
  if (node.type === 'apex') {
    const S = APEX_ICON
    return (
      <Tippy
        content={
          <div className="py-0.5" style={{ maxWidth: 280 }}>
            <p className="font-semibold text-xs text-wow-gold mb-1">{node.name}</p>
            <p className="text-xs text-wow-muted">{count} / {totalBuilds} builds</p>
          </div>
        }
        placement="top"
        delay={[300, 0]}
      >
        <div
          style={{
            position: 'absolute',
            left: px - S / 2,
            top: py - S / 2,
            cursor: 'default',
          }}
        >
          <div
            style={{
              width: S,
              height: S,
              borderRadius: '50%',
              overflow: 'hidden',
              border: `2px solid ${rarity.color}`,
              boxShadow: `0 0 7px ${rarity.glow}`,
              opacity: count === 0 ? 0.12 : 1,
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
          </div>
        </div>
      </Tippy>
    )
  }

  // ── Round / square node ───────────────────────────────────────────────────
  const S = ICON
  const isRound = node.type === 'round'

  return (
    <Tippy
      content={
        <div className="py-0.5" style={{ maxWidth: 260 }}>
          <p className="font-semibold text-xs text-wow-gold">{node.name}</p>
          {node.alreadyGranted ? (
            <p className="text-xs text-wow-dim mt-1 italic">Passive — always active</p>
          ) : (
            <p className="text-xs text-wow-muted mt-0.5">{count} / {totalBuilds} builds</p>
          )}
        </div>
      }
      placement="top"
      delay={[300, 0]}
    >
      <div
        style={{
          position: 'absolute',
          left: px - S / 2,
          top: py - S / 2,
          cursor: 'default',
        }}
      >
        <div
          style={{
            width: S,
            height: S,
            borderRadius: isRound ? '50%' : 4,
            overflow: 'hidden',
            border: `1.5px solid ${rarity.color}`,
            boxShadow: `0 0 7px ${rarity.glow}`,
            opacity: count === 0 ? 0.12 : 1,
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
        </div>
      </div>
    </Tippy>
  )
}

// ─── Heatmap panel ────────────────────────────────────────────────────────────

function HeatmapPanel({ nodes, nodeById, stats, totalBuilds }) {
  const { minX, minY, W, H } = useMemo(() => panelBounds(nodes), [nodes])
  const edges = useMemo(() => panelEdges(nodes, nodeById, minX, minY), [nodes, nodeById, minX, minY])

  return (
    <div style={{ position: 'relative', width: W, height: H, flexShrink: 0 }}>
      <svg
        width={W}
        height={H}
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}
      >
        {edges.map((e, i) => {
          const fromPresent =
            (stats[e.fromId]?.count ?? 0) > 0 || nodeById[e.fromId]?.alreadyGranted
          const toPresent =
            (stats[e.toId]?.count ?? 0) > 0 || nodeById[e.toId]?.alreadyGranted
          const lit = fromPresent && toPresent
          return (
            <line
              key={i}
              x1={e.x1}
              y1={e.y1}
              x2={e.x2}
              y2={e.y2}
              stroke={lit ? '#c8a84b' : '#5a4a1e'}
              strokeWidth={lit ? 2 : 1}
            />
          )
        })}
      </svg>

      {nodes.map((node) => (
        <HeatmapNode
          key={node.id}
          node={node}
          px={(node.posX - minX) * CELL + PAD}
          py={(node.posY - minY) * CELL + PAD}
          stat={stats[node.id]}
          totalBuilds={totalBuilds}
          alreadyGranted={node.alreadyGranted}
        />
      ))}
    </div>
  )
}

// ─── Panel label ──────────────────────────────────────────────────────────────

function PanelLabel({ children }) {
  return (
    <p className="text-wow-gold-dark text-[10px] uppercase tracking-widest mb-1 pl-0.5 select-none">
      {children}
    </p>
  )
}

// ─── Main export ──────────────────────────────────────────────────────────────

export default function HeatmapTree({ treeData, builds }) {
  const totalBuilds = builds.length

  const nodeById = useMemo(() => byId(treeData.nodes), [treeData])

  const classNodes = useMemo(
    () => treeData.nodes.filter((n) => n.treeType === 'class'),
    [treeData],
  )
  const specNodes = useMemo(
    () => treeData.nodes.filter((n) => n.treeType === 'spec'),
    [treeData],
  )
  const leftNodes = useMemo(
    () => treeData.nodes.filter((n) => n.heroSubtree === treeData.heroSubtrees.left.name),
    [treeData],
  )
  const rightNodes = useMemo(
    () => treeData.nodes.filter((n) => n.heroSubtree === treeData.heroSubtrees.right.name),
    [treeData],
  )

  const stats = useMemo(
    () => computeStats(builds, treeData.nodes),
    [builds, treeData],
  )

  const sharedPanel = { nodeById, stats, totalBuilds }

  return (
    <div>
      <RarityLegend n={totalBuilds} />

      <div className="overflow-x-auto pb-1">
        <div className="inline-flex flex-col gap-4 min-w-max">

          {/* ── Class + Spec panels ────────────────────────────────────────── */}
          <div className="flex items-start">
            <div>
              <PanelLabel>Class</PanelLabel>
              <HeatmapPanel nodes={classNodes} {...sharedPanel} />
            </div>

            <div className="self-stretch w-px bg-wow-dim mx-3 mt-5" />

            <div>
              <PanelLabel>Spec</PanelLabel>
              <HeatmapPanel nodes={specNodes} {...sharedPanel} />
            </div>
          </div>

          {/* ── Hero subtrees ──────────────────────────────────────────────── */}
          <div>
            <div className="flex items-center gap-3 mb-2">
              <div className="flex-1 h-px bg-wow-dim" />
              <span className="text-wow-gold-dark text-[10px] tracking-wide select-none">
                {treeData.heroSubtrees.left.name}
              </span>
              <span className="text-wow-dim text-[10px] select-none">|</span>
              <span className="text-wow-gold-dark text-[10px] tracking-wide select-none">
                {treeData.heroSubtrees.right.name}
              </span>
              <div className="flex-1 h-px bg-wow-dim" />
            </div>

            <div className="flex items-start">
              <HeatmapPanel nodes={leftNodes} {...sharedPanel} />
              <div className="self-stretch w-px bg-wow-dim mx-3" />
              <HeatmapPanel nodes={rightNodes} {...sharedPanel} />
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}

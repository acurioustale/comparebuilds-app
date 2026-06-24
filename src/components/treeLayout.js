// ─── Shared talent-tree layout ────────────────────────────────────────────────
//
// Geometry constants and pure layout helpers shared by TalentTree and HeatmapTree
// so the two renderers can't drift apart.

export const CELL        = 36 // grid spacing between node centres
export const ICON        = 26 // round/square node size
export const CHOICE_ICON = 20 // per-option size for choice nodes
export const APEX_ICON   = 34 // apex (capstone) node size
export const CHOICE_GAP  = 4  // gap between a choice node's two options
export const PAD         = 24 // panel padding around the node grid

// ─── Responsive stacking classes ──────────────────────────────────────────────
//
// Tailwind classes for a section's row container and its inter-panel divider,
// shared by TalentTree and HeatmapTree so the two can't drift. `layout` null keeps
// the responsive media query (interactive tree); 'row' / 'stacked' force the layout
// when a coordinator (FitToWidth) drives it from the zoom scale.

/** Section container: panels side by side ('row') or stacked. `justify` centres a row. */
export function sectionRowClass(layout, justify = false) {
  if (layout == null) {
    return `flex flex-col items-center gap-5 2xl:flex-row 2xl:items-start ${justify ? '2xl:justify-center ' : ''}2xl:gap-0`
  }
  if (layout === 'row') {
    return `flex flex-row items-start gap-0${justify ? ' justify-center' : ''}`
  }
  return 'flex flex-col items-center gap-5'
}

/** Inter-panel divider: shown only in row layout. `extra` adds layout-specific classes. */
export function dividerClass(layout, extra = '') {
  if (layout == null) return `hidden 2xl:block self-stretch w-px bg-wow-dim mx-3 ${extra}`
  if (layout === 'row') return `self-stretch w-px bg-wow-dim mx-3 ${extra}`
  return 'hidden'
}

/** Builds an `{ id: node }` lookup map from a node array. */
export function byId(nodes) {
  const m = {}
  for (const n of nodes) m[n.id] = n
  return m
}

/**
 * Pixel bounds of a panel's node grid.
 * @returns {{ minX: number, minY: number, W: number, H: number }}
 */
export function panelBounds(nodes) {
  const xs = nodes.map((n) => n.posX)
  const ys = nodes.map((n) => n.posY)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return {
    minX,
    minY,
    W: (maxX - minX) * CELL + PAD * 2,
    H: (maxY - minY) * CELL + PAD * 2,
  }
}

// Layout chrome widths used between/around panels, in px. Kept here next to the
// geometry so the natural-width math can't drift from what the renderer draws.
const SECTION_DIVIDER = 25 // w-px (1) + mx-3 either side (12 + 12)
const CARD_CHROME     = 34 // card p-4 (16 + 16) plus the .wow-panel 1px border, both
                           // sides (box-sizing: border-box, so the border adds width)

/**
 * Natural (unscaled) card widths of a single talent tree in each layout, computed
 * straight from panel geometry — no DOM measurement, so the responsive coordinator
 * can decide layout/scale without a measure→render feedback loop.
 *
 *   - `row`     — Class ∥ Spec and hero left ∥ right side by side.
 *   - `stacked` — every panel full width, one per row (≈ the widest single panel).
 *
 * @returns {{ row: number, stacked: number }}
 */
export function treeNaturalWidths(treeData) {
  const { nodes, heroSubtrees } = treeData
  const classW = panelBounds(nodes.filter((n) => n.treeType === 'class')).W
  const specW  = panelBounds(nodes.filter((n) => n.treeType === 'spec')).W
  const leftW  = panelBounds(nodes.filter((n) => n.heroSubtree === heroSubtrees.left.name)).W
  const rightW = panelBounds(nodes.filter((n) => n.heroSubtree === heroSubtrees.right.name)).W

  const row = Math.max(
    classW + SECTION_DIVIDER + specW,
    leftW  + SECTION_DIVIDER + rightW,
  ) + CARD_CHROME
  const stacked = Math.max(classW, specW, leftW, rightW) + CARD_CHROME
  return { row, stacked }
}

/**
 * Natural card widths of the section-paired two-build diff in each layout. Each
 * section pairs the two builds' panels (gap-8 between them); the hero section pairs
 * two hero blocks, each itself left ∥ right.
 *
 *   - `row`     — the two builds' panels side by side per section.
 *   - `stacked` — the two builds stacked per section (≈ one column's width; the hero
 *                 block stays left ∥ right within a column).
 *
 * @returns {{ row: number, stacked: number }}
 */
export function pairedNaturalWidths(treeData) {
  const { nodes, heroSubtrees } = treeData
  const COLUMN_GAP = 32 // gap-8 between the two builds when paired
  const classW = panelBounds(nodes.filter((n) => n.treeType === 'class')).W
  const specW  = panelBounds(nodes.filter((n) => n.treeType === 'spec')).W
  const leftW  = panelBounds(nodes.filter((n) => n.heroSubtree === heroSubtrees.left.name)).W
  const rightW = panelBounds(nodes.filter((n) => n.heroSubtree === heroSubtrees.right.name)).W
  const heroBlock = leftW + SECTION_DIVIDER + rightW

  const row = Math.max(
    2 * classW + COLUMN_GAP,
    2 * specW + COLUMN_GAP,
    2 * heroBlock + COLUMN_GAP,
  ) + CARD_CHROME
  const stacked = Math.max(classW, specW, heroBlock) + CARD_CHROME
  return { row, stacked }
}

/**
 * Deduplicated edge list for the panel, in pixel coordinates. Only edges whose
 * both endpoints are in this panel are returned; each undirected edge once.
 * @returns {Array<{x1,y1,x2,y2,fromId,toId}>}
 */
export function panelEdges(nodes, nodeById, minX, minY) {
  const nodeIds = new Set(nodes.map((n) => n.id))
  const seen = new Set()
  const result = []
  for (const node of nodes) {
    const connSeen = new Set()
    for (const connId of node.connections) {
      if (connSeen.has(connId)) continue
      connSeen.add(connId)
      if (!nodeIds.has(connId) || !nodeById[connId]) continue
      const a = Math.min(node.id, connId)
      const b = Math.max(node.id, connId)
      if (seen.has(`${a}:${b}`)) continue
      seen.add(`${a}:${b}`)
      const conn = nodeById[connId]
      result.push({
        x1: (node.posX - minX) * CELL + PAD,
        y1: (node.posY - minY) * CELL + PAD,
        x2: (conn.posX - minX) * CELL + PAD,
        y2: (conn.posY - minY) * CELL + PAD,
        fromId: node.id,
        toId: connId,
      })
    }
  }
  return result
}

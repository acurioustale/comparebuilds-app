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

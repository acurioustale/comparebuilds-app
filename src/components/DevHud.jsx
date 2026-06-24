import { useEffect, useState } from 'react'

/**
 * Dev-only responsive HUD for the responsive-rework branch. Pinned bottom-right,
 * live-updates on resize.
 *
 * Reflects THIS branch's behaviour: Class/Spec/Hero stacking at md (768), and the
 * two-build diff going side-by-side at 2xl (1536). Zoom, the 320px floor, and the
 * two-build heatmap fallback are disabled here, so they're noted as off.
 *
 * Renders only under `npm run dev` or with a `?hud` query param. Not for prod.
 */
export default function DevHud() {
  const [w, setW] = useState(() => window.innerWidth)

  useEffect(() => {
    let raf
    const read = () => {
      setW(window.innerWidth)
      raf = requestAnimationFrame(read)
    }
    read()
    return () => cancelAnimationFrame(raf)
  }, [])

  const stacked = w < 1536       // 2xl: Class/Spec/Hero stacking
  const diffPaired = w >= 1536   // 2xl: section-paired diff (paired vs stacked)

  const Row = ({ label, value, warn }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14 }}>
      <span style={{ opacity: 0.55 }}>{label}</span>
      <span style={{ color: warn ? '#e8c96b' : '#f0e6c8', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  )

  return (
    <div
      style={{
        position: 'fixed', bottom: 10, right: 10, zIndex: 99999,
        background: 'rgba(10,8,4,0.94)', border: '1px solid #8b6914', borderRadius: 6,
        padding: '8px 11px', minWidth: 190, pointerEvents: 'none',
        font: '11px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace', color: '#f0e6c8',
        boxShadow: '0 4px 16px rgba(0,0,0,0.6)', letterSpacing: '0.02em',
      }}
    >
      <div style={{ color: '#c8a84b', marginBottom: 4, fontWeight: 700 }}>responsive HUD</div>
      <Row label="viewport" value={`${w}px`} />
      <Row label="trees" value={stacked ? 'stacked' : 'side-by-side'} warn={stacked} />
      <Row label="2-build" value={diffPaired ? 'paired' : 'stacked'} warn={!diffPaired} />
      <div style={{ marginTop: 5, paddingTop: 5, borderTop: '1px solid rgba(200,168,75,0.25)', opacity: 0.5, fontSize: 10 }}>
        stack 1536 · pair 1536 · zoom off · no floor
      </div>
    </div>
  )
}

import { useRef, useState, useLayoutEffect } from 'react'

/**
 * Fits a fixed-aspect diagram (a talent tree) to the available width by uniform
 * CSS transform — scale, don't reflow — with two cooperating mechanisms:
 *
 *   1. ZOOM. Scale the current layout to fill the width, never past 1× (bitmap
 *      icons would blur), never below `minScale` (then it scrolls instead).
 *   2. REFLOW. When zoom alone would push the wide "row" layout below `floorScale`,
 *      switch to the narrower "stacked" layout — which jumps back near 1× — and
 *      keep zooming from there. Each reflow is thus motivated by readability, not a
 *      fixed pixel breakpoint, and the stack point adapts per build (a narrow class
 *      stays side-by-side longer than a wide one).
 *
 * Two modes:
 *   - `widths` given → two-tier mode. `children` is a function `(layout) => node`
 *     that renders at the chosen layout ('row' | 'stacked'). Layout and scale are
 *     decided from the *computed* natural widths (no DOM measurement of width), so
 *     there's no measure→render feedback loop; only height is measured, to size the
 *     centred footprint (a transform leaves the original box, which would otherwise
 *     leave a gap below).
 *   - `widths` omitted → passthrough. Renders `children` at natural size, scrolling
 *     when too wide. Used by the views not yet migrated to the two-tier model.
 *
 * The full-width container's `clientWidth` is the true available width; with
 * `scrollbar-gutter: stable` on <html> it doesn't jump when a tall layout summons
 * the scrollbar, so the layout decision is free of scrollbar hysteresis.
 */
export default function FitToWidth({
  widths = null,
  minScale = 0.45,
  floorScale = 0.62,
  className = '',
  children,
}) {
  const containerRef = useRef(null)
  const contentRef = useRef(null)
  const [avail, setAvail] = useState(0)
  const [contentH, setContentH] = useState(0)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    const measure = () => {
      setAvail(container.clientWidth)
      // offsetHeight is the untransformed height (transforms don't change layout
      // boxes), so this never feeds back into the scale it's used to size.
      if (contentRef.current) setContentH(contentRef.current.offsetHeight)
    }

    measure()
    window.addEventListener('resize', measure)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(container)
    if (contentRef.current) ro?.observe(contentRef.current)
    return () => {
      window.removeEventListener('resize', measure)
      ro?.disconnect()
    }
  }, [])

  // ── Passthrough mode (no computed widths) ─────────────────────────────────────
  if (!widths) {
    return (
      <div ref={containerRef} className={`overflow-x-auto ${className}`} style={{ width: '100%' }}>
        <div style={{ width: 'max-content', maxWidth: '100%', margin: '0 auto' }}>
          <div ref={contentRef} style={{ width: 'max-content' }}>
            {children}
          </div>
        </div>
      </div>
    )
  }

  // ── Two-tier mode ─────────────────────────────────────────────────────────────
  // Default to 'row' until measured (avail === 0, e.g. jsdom) so SSR/tests get the
  // wide layout at 1×.
  let layout = 'row'
  let scale = 1
  if (avail > 0) {
    // Keep the row layout while it can be shown at >= floorScale; below that the
    // stacked layout (≈ half the width) reads better even though it's taller.
    layout = avail >= floorScale * widths.row ? 'row' : 'stacked'
    const natW = layout === 'row' ? widths.row : widths.stacked
    scale = Math.max(minScale, Math.min(1, avail / natW))
  }
  const natW = layout === 'row' ? widths.row : widths.stacked

  return (
    <div
      ref={containerRef}
      className={`overflow-x-auto ${className}`}
      style={{ width: '100%' }}
    >
      {/* Footprint sized to the scaled box so the page reserves exactly what's
          visible (no phantom gap) and the tree stays centred. */}
      <div
        style={{
          width: natW * scale,
          height: contentH ? contentH * scale : undefined,
          margin: '0 auto',
        }}
      >
        <div
          ref={contentRef}
          style={{
            width: 'max-content',
            transformOrigin: 'top left',
            transform: scale !== 1 ? `scale(${scale})` : undefined,
          }}
        >
          {children(layout)}
        </div>
      </div>
    </div>
  )
}

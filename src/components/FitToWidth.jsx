import { useRef, useState, useLayoutEffect } from 'react'

/**
 * Scales its child down to fit the available width by uniform CSS transform — the
 * right model for a fixed-aspect diagram like a talent tree (scale, don't reflow).
 *
 *   - Never upscales past 1× (bitmap icons would blur).
 *   - Below `minScale`, stops shrinking and scrolls horizontally instead of
 *     becoming unreadably small (phones).
 *
 * IMPORTANT: this must be the full-width element wrapping a shrink-to-fit child
 * (e.g. a card that hugs the tree). It measures its OWN 100%-width box for the
 * available width — never the child — so the child's scaled size can't feed back
 * into the measurement (which would lock the scale at the floor). CSS transforms
 * don't affect layout boxes, so the child's natural size reads straight from
 * offsetWidth. Falls back to an unscaled passthrough where there's no layout
 * (e.g. jsdom tests).
 */
export default function FitToWidth({ minScale = 0.45, className = '', children }) {
  const containerRef = useRef(null)
  const contentRef = useRef(null)
  const [scale, setScale] = useState(1)
  const [nat, setNat] = useState({ w: 0, h: 0 })

  useLayoutEffect(() => {
    const container = containerRef.current
    const content = contentRef.current
    if (!container || !content) return

    const measure = () => {
      const w = content.offsetWidth
      const h = content.offsetHeight
      const avail = container.clientWidth
      if (!w || !avail) return // not laid out (e.g. jsdom) → leave scale at 1
      setScale(Math.max(minScale, Math.min(1, avail / w)))
      setNat({ w, h })
    }

    measure()
    window.addEventListener('resize', measure)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(container)
    ro?.observe(content)
    return () => {
      window.removeEventListener('resize', measure)
      ro?.disconnect()
    }
  }, [minScale])

  const scaled = scale !== 1 && nat.w > 0

  return (
    // Full-width measurer — clientWidth here is the true available width.
    <div ref={containerRef} className={`overflow-x-auto ${className}`} style={{ width: '100%' }}>
      {/* Centered footprint, sized to the scaled child so layout flows correctly. */}
      <div
        style={
          scaled
            ? { width: nat.w * scale, height: nat.h * scale, margin: '0 auto' }
            : { width: 'max-content', maxWidth: '100%', margin: '0 auto' }
        }
      >
        <div
          ref={contentRef}
          style={{
            width: 'max-content',
            transformOrigin: 'top left',
            transform: scaled ? `scale(${scale})` : undefined,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  )
}

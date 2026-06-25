// Search box that filters the visible tree(s). Controlled by MainView; the
// actual highlighting happens in TalentNode/HeatmapNode via SearchContext.
export default function TalentSearch({ value, onChange, matchCount }) {
  const active = value.trim().length > 0
  return (
    <div className="max-w-2xl mx-auto mb-2">
      <div className="flex items-center gap-2 px-2.5 py-1.5 rounded"
        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid #3a2e1a' }}>
        <span className="text-wow-dim text-xs select-none" aria-hidden>⌕</span>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search talents…"
          aria-label="Search talents"
          spellCheck={false}
          autoComplete="off"
          className="flex-1 min-w-0 bg-transparent text-xs text-wow-text placeholder-wow-dim outline-none"
        />
        {active && (
          <>
            <span className="text-wow-dim text-xs tabular-nums select-none">
              {matchCount} {matchCount === 1 ? 'match' : 'matches'}
            </span>
            <button
              onClick={() => onChange('')}
              aria-label="Clear search"
              className="shrink-0 text-wow-dim hover:text-wow-text transition-colors text-sm leading-none"
            >
              ×
            </button>
          </>
        )}
      </div>
    </div>
  )
}

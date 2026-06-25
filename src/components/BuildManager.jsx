import { useState, useRef, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import Tippy from '@tippyjs/react'
import 'tippy.js/dist/tippy.css'
import { useBuildsStore, MAX_BUILDS, MAX_BUILD_NAME_LEN } from '../store/buildsStore'
import { encodeBuildsHash } from '../lib/shareLink'
import classesIndex from '../data/classes.json'
import { zamimg } from '../lib/zamimg'
import { activeHeroSubtree } from '../lib/spendRules'

function ClassIcon({ name, size = 36 }) {
  // WoW class icons on zamimg use classicon_{name} with underscores removed.
  return (
    <img
      src={zamimg('classicon_' + name.replaceAll('_', ''))}
      width={size}
      height={size}
      alt=""
      draggable={false}
      style={{ display: 'block', borderRadius: 4, flexShrink: 0 }}
    />
  )
}

function SpecIcon({ icon, size = 24 }) {
  return (
    <img
      src={zamimg(icon)}
      width={size}
      height={size}
      alt=""
      draggable={false}
      style={{ display: 'block', borderRadius: 3, flexShrink: 0 }}
    />
  )
}

// ─── Class grid ───────────────────────────────────────────────────────────────

function ClassGrid({ classes, activeClassId, locked, onSelect }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {classes
        .filter((c) => c.implemented)
        .map((cls) => {
          const isActive = cls.id === activeClassId
          return (
            <Tippy
              key={cls.id}
              content={locked && !isActive ? 'Clear builds to switch class' : cls.displayName}
              placement="top"
              delay={[400, 0]}
            >
              <button
                onClick={() => onSelect(cls.id)}
                disabled={locked && !isActive}
                aria-pressed={isActive}
                className={[
                  'wow-class-btn rounded p-0.5 transition-all outline-none focus-visible:ring-2 focus-visible:ring-wow-gold',
                  isActive
                    ? 'wow-active opacity-100'
                    : locked
                    ? 'opacity-25 cursor-not-allowed'
                    : 'opacity-50 hover:opacity-80',
                ].join(' ')}
                style={isActive ? { boxShadow: `0 0 0 2px ${cls.color}` } : undefined}
              >
                <ClassIcon name={cls.name} size={36} />
              </button>
            </Tippy>
          )
        })}
    </div>
  )
}

// ─── Spec row ─────────────────────────────────────────────────────────────────

function SpecRow({ specs, activeSpecId, onSelect }) {
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {specs.map((spec) => {
        const isActive = spec.id === activeSpecId
        return (
          <button
            key={spec.id}
            onClick={() => onSelect?.(spec.id)}
            disabled={!onSelect || isActive}
            className={[
              'flex items-center gap-1.5 px-2 py-1 rounded text-xs select-none transition-all outline-none',
              isActive
                ? 'text-wow-gold ring-1 ring-wow-gold-dark'
                : onSelect
                  ? 'text-wow-muted hover:text-wow-text cursor-pointer'
                  : 'text-wow-muted cursor-default',
            ].join(' ')}
            style={isActive ? { background: 'rgba(200,168,75,0.08)' } : { background: 'rgba(255,255,255,0.03)' }}
          >
            <SpecIcon icon={spec.icon} size={20} />
            <span>{spec.displayName}</span>
          </button>
        )
      })}
    </div>
  )
}

// ─── Build slot (filled) ──────────────────────────────────────────────────────

function SlotStatus({ parsed, loading }) {
  if (loading) {
    return (
      <span className="w-16 text-right text-wow-dim text-xs animate-pulse">loading…</span>
    )
  }
  if (parsed === undefined || parsed === null) {
    return (
      <Tippy content="Failed to parse" placement="left">
        <span className="w-4 text-center text-red-500 text-sm cursor-default select-none leading-none">
          ✕
        </span>
      </Tippy>
    )
  }
  return (
    <span className="w-4 text-center text-green-500 text-sm select-none leading-none">✓</span>
  )
}

function pointSummary(parsed, treeData) {
  if (!parsed || !treeData) return null
  const budget = treeData.pointBudget
  const pts = { class: 0, spec: 0, hero: 0 }
  for (const n of treeData.nodes) {
    if (n.alreadyGranted) continue
    const s = parsed.nodes[n.id]
    if (s) pts[n.treeType] = (pts[n.treeType] ?? 0) + (s.pointsInvested ?? 0)
  }
  return `Class: ${pts.class}/${budget.class} · Spec: ${pts.spec}/${budget.spec} · Hero: ${pts.hero}/${budget.hero}`
}

function FilledSlot({ index, name, label, summary, value, parsed, loading, onRemove, onRename }) {
  const [flash, setFlash] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value)
      setFlash(true)
      setTimeout(() => setFlash(false), 1500)
    } catch {
      // clipboard unavailable — silently ignore
    }
  }, [value])

  return (
    <div className="flex items-center gap-2 min-w-0">
      <SlotNumber n={index + 1} />

      {/* Editable slot name. Empty shows the computed default as a placeholder. */}
      <input
        value={name}
        onChange={(e) => onRename(e.target.value)}
        placeholder={label}
        maxLength={MAX_BUILD_NAME_LEN}
        aria-label={`Name for build ${index + 1}`}
        spellCheck={false}
        className="flex-1 min-w-0 text-xs rounded px-2 py-1.5 text-wow-gold placeholder-wow-dim outline-none transition-colors"
        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid #3a2e1a' }}
        onFocus={(e) => { e.target.style.borderColor = '#8b6914' }}
        onBlur={(e) => { e.target.style.borderColor = '#3a2e1a' }}
      />

      <Tippy content={flash ? 'Copied!' : (summary ?? 'Copy build string')} placement="bottom" delay={[300, 0]}>
        <button
          onClick={handleCopy}
          aria-label="Copy build string"
          className="shrink-0 w-6 h-6 flex items-center justify-center transition-colors text-sm leading-none rounded"
          style={{ color: flash ? '#4ade80' : undefined }}
        >
          {flash ? '✓' : '⧉'}
        </button>
      </Tippy>

      <button
        onClick={onRemove}
        title="Remove"
        className="shrink-0 w-6 h-6 flex items-center justify-center text-wow-dim hover:text-red-400 transition-colors text-base leading-none rounded"
      >
        ×
      </button>

      <SlotStatus parsed={parsed} loading={loading} />
    </div>
  )
}

// ─── Empty slot (input) ───────────────────────────────────────────────────────

function EmptySlot({ index, onAdd, errorMsg }) {
  const [value, setValue] = useState('')
  const inputRef = useRef(null)

  const submit = useCallback(
    (text) => {
      const trimmed = text ?? value.trim()
      if (!trimmed) return
      setValue('')
      onAdd(trimmed)
    },
    [value, onAdd],
  )

  // Auto-submit on paste so users don't need to press Enter
  const handlePaste = (e) => {
    const pasted = e.clipboardData?.getData('text/plain') ?? ''
    if (pasted.trim()) {
      e.preventDefault()
      submit(pasted.trim())
    }
  }

  // Clipboard button: read directly from OS clipboard
  const handleClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text.trim()) submit(text.trim())
    } catch {
      // Permissions denied or not supported; user can paste manually
      inputRef.current?.focus()
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <SlotNumber n={index + 1} muted />

        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          onPaste={handlePaste}
          placeholder="Paste build string…"
          className="flex-1 font-mono text-xs rounded px-2 py-1.5 text-wow-text placeholder-wow-dim outline-none transition-colors"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid #3a2e1a' }}
          onFocus={(e) => { e.target.style.borderColor = '#8b6914' }}
          onBlur={(e) => { e.target.style.borderColor = '#3a2e1a' }}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
        />

        <button
          onClick={handleClipboard}
          title="Paste from clipboard"
          className="wow-btn shrink-0 px-2.5 py-1.5 text-xs rounded"
        >
          Paste
        </button>

        {/* Spacer aligns with the status icon column of filled slots */}
        <span className="w-4 shrink-0" />
      </div>

      {errorMsg && (
        <p className="ml-[1.375rem] text-red-400 text-xs leading-snug pl-2">{errorMsg}</p>
      )}
    </div>
  )
}

// Shared slot number label
function SlotNumber({ n, muted = false }) {
  return (
    <span
      className={[
        'shrink-0 w-4 text-right text-xs tabular-nums select-none',
        muted ? 'text-wow-dim' : 'text-wow-muted',
      ].join(' ')}
    >
      {n}
    </span>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function BuildManager() {
  const {
    buildStrings,
    buildNames,
    parsedBuilds,
    classId,
    specId,
    treeData,
    isLoading,
    error,
    addBuild,
    removeBuild,
    clearAllBuilds,
    preloadSpec,
    setBuildName,
  } = useBuildsStore(
    useShallow((s) => ({
      buildStrings: s.buildStrings,
      buildNames: s.buildNames,
      parsedBuilds: s.parsedBuilds,
      classId: s.classId,
      specId: s.specId,
      treeData: s.treeData,
      isLoading: s.isLoading,
      error: s.error,
      addBuild: s.addBuild,
      removeBuild: s.removeBuild,
      clearAllBuilds: s.clearAllBuilds,
      preloadSpec: s.preloadSpec,
      setBuildName: s.setBuildName,
    })),
  )

  const [copyState, setCopyState] = useState('idle') // 'idle' | 'copying' | 'copied' | 'error'
  const [directState, setDirectState] = useState('idle') // 'idle' | 'copied' | 'error'

  // Local class selection used before any builds are loaded
  const [localClassId, setLocalClassId] = useState(null)

  // Store classId takes precedence once builds exist
  const activeClassId = classId ?? localClassId
  const activeClass   = classesIndex.find((c) => c.id === activeClassId)
  const classLocked   = classId !== null

  // Human-readable spec/class names, used for labels and the share payload.
  const specDisplayName  = activeClass?.specs.find((s) => s.id === specId)?.displayName ?? ''
  const classDisplayName = activeClass?.displayName ?? ''

  // Instant link: encodes the builds straight into the URL hash — no server
  // round-trip, no rate limit, works offline. The sibling of the short link.
  const handleCopyDirectLink = useCallback(async () => {
    if (directState !== 'idle') return
    try {
      const token = encodeBuildsHash({ builds: buildStrings, names: buildNames })
      const url = `${window.location.origin}${window.location.pathname}#b=${token}`
      await navigator.clipboard.writeText(url)
      setDirectState('copied')
    } catch {
      setDirectState('error')
    } finally {
      setTimeout(() => setDirectState('idle'), 2000)
    }
  }, [directState, buildStrings, buildNames])

  const handleCopyLink = useCallback(async () => {
    if (copyState !== 'idle') return
    setCopyState('copying')
    try {
      const apiBase = import.meta.env.BASE_URL + 'api/share.php'
      // Include labels only when at least one slot is named, plus the display
      // names the OG-image endpoint needs (it has no class index to look them up).
      const labels = buildNames.some(Boolean) ? buildNames : undefined
      const res = await fetch(apiBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classId, specId, builds: buildStrings, labels, className: classDisplayName, specName: specDisplayName }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? `HTTP ${res.status}`)
      }
      const { id } = await res.json()
      // /s/<id> is the server-rendered share page (link previews); it redirects
      // humans to the SPA. Old #<id> links keep working via the route resolver.
      const url = `${window.location.origin}/s/${id}`
      await navigator.clipboard.writeText(url)
      setCopyState('copied')
    } catch {
      setCopyState('error')
    } finally {
      setTimeout(() => setCopyState('idle'), 2000)
    }
  }, [copyState, classId, specId, buildStrings, buildNames, classDisplayName, specDisplayName])

  // Human-readable build label: "Build N — [Hero Spec] Spec Class"
  const buildLabel = (n, parsedBuild) => {
    if (!specDisplayName || !classDisplayName) return `Build ${n}`
    const heroSpec = parsedBuild && treeData ? activeHeroSubtree(treeData.nodes, parsedBuild.nodes) : null
    const prefix = heroSpec ? `${heroSpec} ` : ''
    return `Build ${n} — ${prefix}${specDisplayName} ${classDisplayName}`
  }

  const handleClassSelect = (id) => {
    if (classLocked) return
    setLocalClassId(id)
    // Reset spec + interactive tree when class changes in interactive mode
    if (buildStrings.length === 0) clearAllBuilds()
  }

  const handleSpecSelect = useCallback((id) => {
    if (classLocked) return
    preloadSpec(id)
  }, [classLocked, preloadSpec])

  // ── Slot layout ────────────────────────────────────────────────────────────
  const filledCount = buildStrings.length
  const canAdd      = filledCount < MAX_BUILDS
  // Always show at least 2 slots so the intent (compare 2 builds) is obvious
  const totalSlots  = Math.max(2, filledCount + (canAdd ? 1 : 0))

  // ── Action button visibility ───────────────────────────────────────────────
  // The share API requires 2–5 builds, so Copy link only appears once at least
  // two builds are loaded and ALL of them are fully parsed (no nulls, no
  // loading in progress).
  const allParsed = filledCount >= 2
    && !isLoading
    && parsedBuilds.length === filledCount
    && parsedBuilds.every(Boolean)

  return (
    <div className="wow-panel text-wow-text p-4 rounded space-y-4 max-w-2xl mx-auto">

      {/* ── Class grid ─────────────────────────────── */}
      <section>
        <SectionLabel>Class</SectionLabel>
        <ClassGrid
          classes={classesIndex}
          activeClassId={activeClassId}
          locked={classLocked}
          onSelect={handleClassSelect}
        />
      </section>

      {/* ── Spec row — only once a class is selected ─ */}
      {activeClass && (
        <section>
          <SectionLabel>Spec</SectionLabel>
          <SpecRow
            specs={activeClass.specs}
            activeSpecId={specId}
            onSelect={classLocked ? null : handleSpecSelect}
          />
        </section>
      )}

      {/* ── Build inputs ───────────────────────────── */}
      <section>
        <div className="flex items-baseline justify-between mb-2">
          <SectionLabel>
            Builds
            <span className="ml-1 text-wow-dim font-normal normal-case tracking-normal">
              {filledCount}/{MAX_BUILDS}
            </span>
          </SectionLabel>
          {filledCount > 0 && (
            <button
              onClick={clearAllBuilds}
              className="text-wow-muted hover:text-red-400 text-xs transition-colors"
            >
              Clear all
            </button>
          )}
        </div>

        <div className="space-y-2">
          {Array.from({ length: totalSlots }, (_, i) => {
            // Filled slot
            if (i < filledCount) {
              return (
                <FilledSlot
                  key={buildStrings[i]}
                  index={i}
                  name={buildNames[i] ?? ''}
                  label={buildLabel(i + 1, parsedBuilds[i])}
                  summary={pointSummary(parsedBuilds[i], treeData)}
                  value={buildStrings[i]}
                  parsed={parsedBuilds[i]}
                  // Show "loading" on the last filled slot while tree data is fetched
                  loading={isLoading && i === filledCount - 1 && parsedBuilds[i] === null}
                  onRemove={() => removeBuild(i)}
                  onRename={(v) => setBuildName(i, v)}
                />
              )
            }

            // Empty input slot — error is only shown on the primary empty slot
            // (the one at filledCount, i.e. the first empty one)
            const isPrimary = i === filledCount
            return (
              <EmptySlot
                key={`empty-${i}`}
                index={i}
                onAdd={addBuild}
                errorMsg={isPrimary ? error : null}
              />
            )
          })}
        </div>
      </section>

      {/* ── Action buttons ─────────────────────────── */}
      {allParsed && (
        <section className="flex justify-end items-center gap-2 pt-3 border-t border-wow-dim">
          <DirectLinkButton state={directState} onClick={handleCopyDirectLink} />
          <CopyLinkButton state={copyState} onClick={handleCopyLink} />
        </section>
      )}
    </div>
  )
}

// ─── Tiny shared presentational bits ─────────────────────────────────────────

function SectionLabel({ children }) {
  return (
    <p className="text-wow-gold-dark text-xs uppercase tracking-widest mb-1.5">{children}</p>
  )
}

function CopyLinkButton({ state, onClick }) {
  const label =
    state === 'copying' ? 'Saving…' :
    state === 'copied'  ? 'Copied!' :
    state === 'error'   ? 'Failed'  : 'Copy link'

  return (
    <button
      onClick={onClick}
      disabled={state !== 'idle'}
      className="wow-btn px-3 py-1.5 text-xs rounded select-none"
      style={
        state === 'copied' ? { color: '#4ade80', borderColor: '#166534' } :
        state === 'error'  ? { color: '#f87171', borderColor: '#7f1d1d' } :
        undefined
      }
    >
      {label}
    </button>
  )
}

// Instant (client-side) link: encodes the builds into the URL hash, copied
// straight to the clipboard with no server call.
function DirectLinkButton({ state, onClick }) {
  const label =
    state === 'copied' ? 'Copied!' :
    state === 'error'  ? 'Failed'  : 'Copy instant link'

  return (
    <Tippy content="A link with the builds encoded in the URL — no server, works offline." placement="top" delay={[300, 0]}>
      <button
        onClick={onClick}
        disabled={state !== 'idle'}
        className="wow-btn px-3 py-1.5 text-xs rounded select-none"
        style={
          state === 'copied' ? { color: '#4ade80', borderColor: '#166534' } :
          state === 'error'  ? { color: '#f87171', borderColor: '#7f1d1d' } :
          undefined
        }
      >
        {label}
      </button>
    </Tippy>
  )
}

// @vitest-environment jsdom
/**
 * App-level flow tests: the two-build comparison view, share-link rehydration,
 * and the StrictMode double-invoke guard (regression test for the fix that
 * stopped shared builds from being added twice in development).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { StrictMode } from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { createRequire } from 'node:module'
import App from './App.jsx'
import { useBuildsStore } from './store/buildsStore.js'
import { collectClassNodes, generateBuildString } from './lib/buildString.js'
import { encodeBuildsHash } from './lib/shareLink.js'

const require = createRequire(import.meta.url)

function genStrings(classSlug, specSlug, n) {
  const data = require(`./data/${classSlug}.json`)
  const classNodes = collectClassNodes(data)
  const spec = data.specs[specSlug]
  const pickable = spec.nodes.filter((nd) => !nd.alreadyGranted)
  const out = []
  for (let k = 1; k <= n; k++) {
    const sel = {}
    for (let i = 0; i < k; i++) {
      const nd = pickable[i]
      sel[nd.id] = {
        pointsInvested: nd.type === 'choice' ? nd.choices[0].maxRanks : nd.maxRanks,
        entryChosen: nd.type === 'choice' ? 0 : null,
      }
    }
    out.push(generateBuildString(sel, spec.specId, classNodes))
  }
  return out
}

const paste = (input, text) =>
  fireEvent.paste(input, { clipboardData: { getData: () => text } })

function mockShareFetch(builds) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ classId: 6, specId: 250, builds }),
  }))
  global.fetch = fetchMock
  return fetchMock
}

// This jsdom setup has no localStorage (the store is built to run without it),
// so the theme suite installs a minimal in-memory stub for the tests that need
// to read a persisted choice back. Guarded with ?. so the other suites, which
// run without it, are unaffected.
function installLocalStorage() {
  const store = new Map()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)) },
      removeItem: (k) => { store.delete(k) },
      clear: () => { store.clear() },
    },
  })
}

beforeEach(() => {
  useBuildsStore.getState().clearAllBuilds()
  window.location.hash = ''
  window.localStorage?.clear()
  delete document.documentElement.dataset.theme
})

afterEach(() => {
  cleanup()
  window.location.hash = ''
  window.localStorage?.clear()
  delete document.documentElement.dataset.theme
  vi.restoreAllMocks()
  delete global.fetch
})

describe('comparison view', () => {
  test('adding two builds renders the side-by-side diff', async () => {
    render(<App />)
    const [a, b] = genStrings('death_knight', 'blood', 2)
    paste(screen.getAllByPlaceholderText('Paste build string…')[0], a)
    await screen.findByPlaceholderText(/Build 1 — Blood Death Knight/)
    paste(screen.getByPlaceholderText('Paste build string…'), b)
    expect(await screen.findByText(/Differences/)).toBeInTheDocument()
  })
})

describe('share rehydration', () => {
  test('loads builds referenced by the URL hash', async () => {
    const builds = genStrings('death_knight', 'blood', 2)
    const fetchMock = mockShareFetch(builds)
    window.location.hash = '#abc123'

    render(<App />)

    expect(await screen.findByText(/Differences/)).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // hash is cleared so a manual reload doesn't re-trigger
    expect(window.location.hash).toBe('')
  })

  test('a bad hash is ignored (no fetch)', async () => {
    const fetchMock = mockShareFetch([])
    window.location.hash = '#tooShortAndWeird!!'
    render(<App />)
    // Nothing to load — the empty build inputs remain
    expect(screen.getAllByRole('textbox').length).toBeGreaterThan(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('rehydration runs only once under StrictMode', async () => {
    const builds = genStrings('death_knight', 'blood', 2)
    const fetchMock = mockShareFetch(builds)
    window.location.hash = '#abcdef'

    render(<StrictMode><App /></StrictMode>)

    expect(await screen.findByText(/Differences/)).toBeInTheDocument()
    // The useRef guard prevents StrictMode's double effect invocation from
    // fetching (and adding the builds) twice.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('loads builds from a client-side #b= instant link without any fetch', async () => {
    const builds = genStrings('death_knight', 'blood', 2)
    const fetchMock = vi.fn()
    global.fetch = fetchMock
    window.location.hash = '#b=' + encodeBuildsHash({ builds })

    render(<App />)

    expect(await screen.findByText(/Differences/)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('')
  })
})

describe('theme toggle', () => {
  beforeEach(installLocalStorage)
  afterEach(() => { delete window.localStorage })

  test('defaults to dark, switches to light, and persists the choice', () => {
    render(<App />)

    expect(document.documentElement.dataset.theme).toBe('dark')

    fireEvent.click(screen.getByRole('button', { name: /switch to light mode/i }))

    expect(document.documentElement.dataset.theme).toBe('light')
    expect(window.localStorage.getItem('comparebuilds-theme')).toBe('light')
    // The button now offers the way back.
    expect(screen.getByRole('button', { name: /switch to dark mode/i })).toBeInTheDocument()
  })

  test('restores a persisted light override on mount', () => {
    window.localStorage.setItem('comparebuilds-theme', 'light')

    render(<App />)

    expect(document.documentElement.dataset.theme).toBe('light')
    expect(screen.getByRole('button', { name: /switch to dark mode/i })).toBeInTheDocument()
  })
})

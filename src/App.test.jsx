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

beforeEach(() => {
  useBuildsStore.getState().clearAllBuilds()
  window.location.hash = ''
})

afterEach(() => {
  cleanup()
  window.location.hash = ''
  vi.restoreAllMocks()
  delete global.fetch
})

describe('comparison view', () => {
  test('adding two builds renders the side-by-side diff', async () => {
    render(<App />)
    const [a, b] = genStrings('death_knight', 'blood', 2)
    paste(screen.getAllByRole('textbox')[0], a)
    await screen.findByText(/Build 1 — Blood Death Knight/)
    paste(screen.getByRole('textbox'), b)
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

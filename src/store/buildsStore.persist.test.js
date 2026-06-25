/**
 * Round-trip tests for localStorage persistence.
 *
 * The store wraps its state in Zustand's `persist` middleware so a page reload
 * does not lose work. Only the small serialisable slices are written; the
 * derived tree/parsed state is rebuilt on rehydration. These tests simulate a
 * reload by re-importing the store module (`vi.resetModules()` → fresh
 * `create(persist(...))`), which rehydrates from the same `localStorage`.
 *
 * Runs in the Node environment (jsdom's default opaque origin disables Web
 * Storage), so we install a minimal in-memory `localStorage` shim — hoisted
 * above the store import so the module's initial rehydration sees it too.
 */

import { describe, test, beforeEach, vi } from 'vitest'

vi.hoisted(() => {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  }
})

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { useBuildsStore } from './buildsStore.js'
import { collectClassNodes, generateBuildString } from '../lib/buildString.js'

const require = createRequire(import.meta.url)
const STORAGE_KEY = 'comparebuilds-state'

const DK = require('../data/death_knight.json')
const DK_NODES = collectClassNodes(DK)
const DK_BLOOD = DK.specs.blood.specId

/** Builds `n` distinct, well-formed Blood DK strings (same shape as the main suite). */
function dkStrings(n) {
  const pickable = DK.specs.blood.nodes.filter((nd) => !nd.alreadyGranted)
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
    out.push(generateBuildString(sel, DK_BLOOD, DK_NODES))
  }
  return out
}

/** Simulates a page reload: drops the module cache and re-imports the store. */
async function reload() {
  vi.resetModules()
  const mod = await import('./buildsStore.js')
  return mod.useBuildsStore
}

beforeEach(() => {
  localStorage.clear()
  useBuildsStore.getState().clearAllBuilds()
})

describe('persistence', () => {
  test('persists only the whitelisted, serialisable slices', async () => {
    const [a] = dkStrings(1)
    await useBuildsStore.getState().addBuild(a)

    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY)).state
    assert.deepStrictEqual(
      Object.keys(persisted).sort(),
      ['addingBuild', 'buildStrings', 'classId', 'interactiveNodes', 'specId'],
    )
    // Derived state must never be written.
    assert.ok(!('treeData' in persisted))
    assert.ok(!('classNodes' in persisted))
    assert.ok(!('parsedBuilds' in persisted))
  })

  test('round-trips added builds: derived tree + parsed state rebuild on reload', async () => {
    const strings = dkStrings(2)
    for (const s of strings) await useBuildsStore.getState().addBuild(s)
    useBuildsStore.getState().startAddingBuild() // entering a third build
    assert.strictEqual(useBuildsStore.getState().addingBuild, true)

    const fresh = await reload()
    // Persisted slices are restored synchronously by the middleware…
    assert.deepStrictEqual(fresh.getState().buildStrings, strings)
    assert.strictEqual(fresh.getState().specId, DK_BLOOD)
    assert.strictEqual(fresh.getState().addingBuild, true)
    // …but derived state starts empty until we rebuild it.
    assert.strictEqual(fresh.getState().treeData, null)

    await fresh.getState().rehydrateTreeData()

    const st = fresh.getState()
    assert.ok(st.treeData, 'treeData rebuilt')
    assert.ok(st.classNodes, 'classNodes rebuilt')
    assert.strictEqual(st.parsedBuilds.length, 2)
    assert.ok(st.parsedBuilds.every(Boolean), 'every build re-parsed')
  })

  test('round-trips an in-progress interactive selection without resetting it', async () => {
    await useBuildsStore.getState().preloadSpec(DK_BLOOD)
    const pick = DK.specs.blood.nodes.find((nd) => !nd.alreadyGranted)
    const sel = { ...useBuildsStore.getState().interactiveNodes, [pick.id]: { pointsInvested: 1, entryChosen: null } }
    useBuildsStore.getState().setInteractiveNodes(sel)
    assert.ok(useBuildsStore.getState().interactiveNodes[pick.id], 'selection set')

    const fresh = await reload()
    assert.strictEqual(fresh.getState().buildStrings.length, 0)
    assert.ok(fresh.getState().interactiveNodes[pick.id], 'selection restored from storage')

    await fresh.getState().rehydrateTreeData()

    const st = fresh.getState()
    assert.ok(st.treeData, 'treeData rebuilt for interactive mode')
    // The in-progress pick must survive — not be clobbered by the granted seed.
    assert.ok(st.interactiveNodes[pick.id], 'interactive selection preserved through rehydration')
  })

  test('drops a restored interactive node that no longer exists in the tree', async () => {
    await useBuildsStore.getState().preloadSpec(DK_BLOOD)
    const pick = DK.specs.blood.nodes.find((nd) => !nd.alreadyGranted)
    // A real pick plus a stale id that isn't in the tree (e.g. removed by a patch).
    const sel = {
      ...useBuildsStore.getState().interactiveNodes,
      [pick.id]: { pointsInvested: 1, entryChosen: null },
      999999999: { pointsInvested: 1, entryChosen: null },
    }
    useBuildsStore.getState().setInteractiveNodes(sel)

    const fresh = await reload()
    assert.ok(fresh.getState().interactiveNodes['999999999'], 'stale id is in storage pre-reconcile')

    await fresh.getState().rehydrateTreeData()

    const st = fresh.getState()
    assert.ok(st.interactiveNodes[pick.id], 'valid pick survives reconciliation')
    assert.ok(!st.interactiveNodes['999999999'], 'stale node id is dropped')
  })

  test('clears stale persisted state when the spec no longer resolves', async () => {
    // Seed localStorage directly with a build referencing a non-existent spec.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      state: { buildStrings: ['CoPAAA'], specId: 99999999, classId: 1, interactiveNodes: {}, addingBuild: false },
    }))

    const fresh = await reload()
    assert.strictEqual(fresh.getState().specId, 99999999, 'unresolved spec restored before recovery')

    await fresh.getState().rehydrateTreeData()

    const st = fresh.getState()
    assert.strictEqual(st.specId, null, 'specId cleared')
    assert.strictEqual(st.buildStrings.length, 0, 'unloadable builds cleared')
    assert.strictEqual(st.treeData, null)
  })
})

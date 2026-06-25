import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import classesIndex from '../data/classes.json'
import { parseSpecId, parseBuildString, collectClassNodes } from '../lib/buildString'
import { buildGrantedSeed } from '../lib/treeLogic'
// NOTE: these limits are mirrored server-side in api/share.php (MAX_BUILDS,
// MAX_BUILD_LEN). Keep the two in sync — the server rejects anything past them, so
// validating here too just gives a clearer message before the share round-trip.
export const MAX_BUILDS = 5
export const MAX_BUILD_LEN = 2000

// Vite creates a lazy chunk per matched file. The glob must be a string literal.
// Paths are relative to this file (src/store/ → src/data/). classes.json is the
// statically-imported index, so it's excluded to keep it out of the lazy chunks
// (and to silence Vite's mixed static/dynamic import warning).
const CLASS_MODULES = import.meta.glob(['../data/*.json', '!../data/classes.json'])

// ─── Hero subtree sanitisation ────────────────────────────────────────────────

/**
 * If `nodes` contains selections from more than one hero subtree, strips all
 * but the dominant one (highest total points invested).  Returns `nodes`
 * unchanged when there is zero or one active subtree.
 */
function sanitizeHeroSubtrees(nodes, treeData) {
  if (!treeData) return nodes

  const subPoints = {}
  for (const n of treeData.nodes) {
    if (n.treeType !== 'hero' || n.alreadyGranted || !nodes[n.id]) continue
    subPoints[n.heroSubtree] = (subPoints[n.heroSubtree] ?? 0) + (nodes[n.id].pointsInvested ?? 0)
  }

  const subs = Object.keys(subPoints)
  if (subs.length <= 1) return nodes

  const keepSub = subs.reduce((a, b) => (subPoints[a] >= subPoints[b] ? a : b))
  const result = { ...nodes }
  for (const n of treeData.nodes) {
    if (n.treeType === 'hero' && !n.alreadyGranted && n.heroSubtree !== keepSub) {
      delete result[n.id]
    }
  }
  return result
}

// ─── Module-level helpers ─────────────────────────────────────────────────────

/**
 * Returns the class and spec entry that owns `specId`, or null if not found.
 * @param {number} specId
 * @returns {{ cls: object, spec: object } | null}
 */
function findClassForSpec(specId) {
  for (const cls of classesIndex) {
    const spec = cls.specs.find((s) => s.id === specId)
    if (spec) return { cls, spec }
  }
  return null
}

/**
 * Dynamically imports a normalised class JSON from src/data/.
 * @param {string} classSlug  e.g. "death_knight"
 * @returns {Promise<object>}
 */
async function importClassData(classSlug) {
  const key = `../data/${classSlug}.json`
  const loader = CLASS_MODULES[key]
  if (!loader) {
    throw new Error(
      `No local data for "${classSlug}" — run "node scripts/ingestTalentData.js" to generate it`,
    )
  }
  const mod = await loader()
  return mod.default ?? mod
}

/**
 * Parses every build string against the loaded node list, returning null for
 * strings that fail (so the array stays parallel to buildStrings).
 * @param {string[]} strings
 * @param {object[]} classNodes
 * @returns {(object|null)[]}
 */
function parseAll(strings, classNodes) {
  return strings.map((s) => {
    try {
      return parseBuildString(s, classNodes)
    } catch {
      return null
    }
  })
}

// ─── Async tree-data loader (module-level to cancel stale loads) ──────────────

// Incremented every time a new load starts. The load callback checks this
// before committing results so a clearAllBuilds() or rapid spec-switch
// never applies stale data.
let loadGen = 0

async function loadTreeData(set, get, classSlug, specSlug, specId, { preserveInteractive = false } = {}) {
  const gen = ++loadGen
  set({ isLoading: true, error: null })

  try {
    const classData = await importClassData(classSlug)

    // Bail if the store was reset or re-targeted while we were awaiting
    if (loadGen !== gen) return

    const classNodes = collectClassNodes(classData)
    const treeData   = classData.specs[specSlug]

    if (!treeData) {
      throw new Error(`Spec "${specSlug}" not found in class data for "${classSlug}"`)
    }

    const currentStrings = get().buildStrings
    set({
      classNodes,
      treeData,
      isLoading: false,
      // Re-parse every string that may have arrived while we were loading
      parsedBuilds: parseAll(currentStrings, classNodes),
      // In interactive mode (no imported builds), seed pre-granted nodes so
      // prerequisite checks evaluate against the full effective selection set.
      // Skipped on rehydration (preserveInteractive), where the persisted
      // in-progress selection must survive the reload.
      ...(currentStrings.length === 0 && !preserveInteractive && {
        interactiveNodes: buildGrantedSeed(treeData),
      }),
    })
  } catch (err) {
    if (loadGen !== gen) return
    set({ isLoading: false, error: `Failed to load tree data: ${err.message}` })
  }
}

// ─── Initial state snapshot (reused for resets) ──────────────────────────────

const EMPTY = {
  /** @type {string[]} Raw base64 build strings (0 – MAX_BUILDS). */
  buildStrings: [],

  /**
   * Parsed results, parallel to buildStrings. null means either "not yet
   * parsed" (tree data loading) or "failed to parse" (bad string).
   * @type {(object|null)[]}
   */
  parsedBuilds: [],

  /** Spec ID shared by all builds; derived from the first valid import. */
  specId: null,

  /** Class ID derived from specId via the classes index. */
  classId: null,

  /**
   * The normalised spec tree object (classData.specs[specSlug]).
   * Available after tree data is loaded; used for display and comparison.
   * @type {object|null}
   */
  treeData: null,

  /**
   * Flat sorted node list for the whole class, ready for parseBuildString().
   * Null until the first build's class data has been loaded.
   * @type {object[]|null}
   */
  classNodes: null,

  isLoading: false,

  /**
   * Last validation or load error. Set on failure, cleared on the next
   * successful addBuild() call. Never cleared automatically — consumers
   * should clear it after displaying it if desired.
   */
  error: null,

  /**
   * Node selections built interactively (before any build string is imported).
   * Keyed by node ID, parallel structure to parsedBuild.nodes.
   * Cleared whenever the store resets to EMPTY.
   * @type {Record<number, {pointsInvested: number, entryChosen: number|null}>}
   */
  interactiveNodes: {},

  /**
   * True while the user is building an additional build via the interactive
   * tree after at least one build has already been exported.  Drives whether
   * MainView renders the interactive tree alongside the comparison view.
   */
  addingBuild: false,
}

// ─── Store ────────────────────────────────────────────────────────────────────

const createStore = (set, get) => ({
  ...EMPTY,

  /**
   * Validates and appends a build string. Async because the first build
   * triggers a dynamic import of the class JSON.
   *
   * Rejects (sets error, returns early) when:
   *   - The string is not valid base64 / missing header bits
   *   - The spec ID is unrecognised
   *   - The spec differs from currently loaded builds
   *   - The build limit (MAX_BUILDS = 5) would be exceeded
   *
   * @param {string} buildString
   */
  addBuild: async (buildString) => {
    // Clear stale error at the start of each attempt
    set({ error: null })

    if (!buildString || typeof buildString !== 'string') {
      set({ error: 'Build string must be a non-empty string.' })
      return
    }

    if (buildString.length > MAX_BUILD_LEN) {
      set({ error: `Build string is too long (max ${MAX_BUILD_LEN} characters).` })
      return
    }

    const { buildStrings, specId: currentSpecId, classNodes, isLoading } = get()

    if (buildStrings.length >= MAX_BUILDS) {
      set({ error: `You can compare at most ${MAX_BUILDS} builds at once.` })
      return
    }

    // Reject exact duplicates — comparing a build against itself is pointless,
    // and identical strings would collide as React keys in the slot list.
    if (buildStrings.includes(buildString)) {
      set({ error: 'That build has already been added.' })
      return
    }

    // ── Parse just the 24-bit header to identify the spec ────────────────────
    let header
    try {
      header = parseSpecId(buildString)
    } catch (err) {
      // Surface the specific reason for an unsupported version; otherwise treat it
      // as an unreadable header (bad base64, truncation, etc.).
      const isVersion = err instanceof RangeError && /version/i.test(err.message)
      set({
        error: isVersion
          ? `${err.message}. This build string is from a newer game format than this tool supports.`
          : 'Could not read the build string header — it may be truncated or corrupt.',
      })
      return
    }

    const match = findClassForSpec(header.specId)
    if (!match) {
      set({
        error: `Spec ID ${header.specId} was not found in the local class index. ` +
               `Try re-running the ingest script for the latest data.`,
      })
      return
    }

    // ── Reject spec mismatches ────────────────────────────────────────────────
    if (currentSpecId !== null && header.specId !== currentSpecId) {
      const existingMatch = findClassForSpec(currentSpecId)
      const existingLabel = existingMatch
        ? `${existingMatch.cls.displayName} — ${existingMatch.spec.displayName}`
        : `spec ${currentSpecId}`
      const incomingLabel = `${match.cls.displayName} — ${match.spec.displayName}`
      set({
        error: `Spec mismatch: loaded builds are ${existingLabel}, ` +
               `but this string is for ${incomingLabel}.`,
      })
      return
    }

    // ── Append the string ─────────────────────────────────────────────────────
    const isFirst       = buildStrings.length === 0
    const newStrings    = [...buildStrings, buildString]
    // Append a null placeholder — becomes a real result once classNodes land
    const newParsed     = [...get().parsedBuilds, null]

    if (isFirst) {
      // Set identity + kick off tree-data load (specId set synchronously so
      // concurrent addBuild calls can see it before the await resolves)
      set({
        buildStrings: newStrings,
        parsedBuilds: newParsed,
        specId:       header.specId,
        classId:      match.cls.id,
      })
      await loadTreeData(set, get, match.cls.name, match.spec.name, header.specId)
    } else if (classNodes && !isLoading) {
      // Tree data already available — parse the new string immediately
      set({
        buildStrings: newStrings,
        parsedBuilds: parseAll(newStrings, classNodes),
      })
    } else {
      // Tree data is mid-load — store the string now; the load callback will
      // call parseAll(get().buildStrings, …) when it finishes, picking this up
      set({ buildStrings: newStrings, parsedBuilds: newParsed })
    }
  },

  /**
   * Removes the build at the given index. Resets all state if the last build
   * is removed so the next addBuild() can start fresh with a different spec.
   *
   * @param {number} index
   */
  removeBuild: (index) => {
    const { buildStrings, parsedBuilds } = get()
    if (index < 0 || index >= buildStrings.length) return

    const newStrings = buildStrings.filter((_, i) => i !== index)
    const newParsed  = parsedBuilds.filter((_, i)  => i !== index)

    if (newStrings.length === 0) {
      // Invalidate any in-flight load so its commit is a no-op
      loadGen++
      set({ ...EMPTY })
    } else {
      set({ buildStrings: newStrings, parsedBuilds: newParsed })
    }
  },

  /**
   * Removes all builds and resets every piece of state to its initial value.
   */
  clearAllBuilds: () => {
    loadGen++       // cancel any in-flight load
    set({ ...EMPTY })
  },

  /**
   * Loads tree data for the interactive calculator without importing a build
   * string. Only operates when no builds are present. Sets specId so the
   * spec row highlights correctly; leaves classId null so the class grid
   * stays unlocked.
   *
   * @param {number} specId
   */
  preloadSpec: async (specId) => {
    if (get().buildStrings.length > 0) return

    const match = findClassForSpec(specId)
    if (!match) return

    set({ specId, classId: null, interactiveNodes: {}, error: null })
    await loadTreeData(set, get, match.cls.name, match.spec.name, specId)
  },

  /**
   * Replaces the interactive node selection wholesale. Called by
   * InteractiveTalentTree on every click.
   *
   * @param {Record<number, {pointsInvested: number, entryChosen: number|null}>} nodes
   */
  setInteractiveNodes: (nodes) => {
    const { treeData } = get()
    set({ interactiveNodes: sanitizeHeroSubtrees(nodes, treeData) })
  },

  /**
   * Enter "add another build" mode: clears the interactive node selection back
   * to the granted seed and shows the interactive tree alongside the comparison.
   */
  startAddingBuild: () => {
    const { treeData } = get()
    if (!treeData) return
    set({ addingBuild: true, interactiveNodes: buildGrantedSeed(treeData) })
  },

  /** Called after a successful interactive export to hide the interactive tree. */
  finishAddingBuild: () => set({ addingBuild: false }),

  /**
   * Rebuilds the derived, non-persisted state (treeData, classNodes,
   * parsedBuilds) after the persisted slices have been rehydrated from
   * localStorage. Reads specId from the restored state, loads the matching
   * class tree, and re-parses any restored build strings. The in-progress
   * interactive selection is preserved (preserveInteractive) rather than reset
   * to the granted seed. No-op when nothing was restored.
   */
  rehydrateTreeData: async () => {
    const { specId } = get()
    if (specId == null) return

    const match = findClassForSpec(specId)
    // The persisted spec no longer exists in the data (e.g. a game patch or a
    // data regen removed it). Don't strand the user on saved-but-unloadable
    // builds — clear back to a clean slate.
    if (!match) {
      loadGen++
      set({ ...EMPTY })
      return
    }

    await loadTreeData(set, get, match.cls.name, match.spec.name, specId, {
      preserveInteractive: true,
    })

    // If the load failed, the restored build strings can never render — discard
    // the stale persisted state rather than leaving a tree-less dead end.
    if (!get().treeData) {
      loadGen++
      set({ ...EMPTY })
      return
    }

    // Drop any restored interactive selections for nodes that no longer exist in
    // the loaded tree, so a stale persisted id can't linger in the selection.
    const known = new Set(get().treeData.nodes.map((n) => n.id))
    const current = get().interactiveNodes
    const reconciled = {}
    let changed = false
    for (const [id, sel] of Object.entries(current)) {
      if (known.has(Number(id))) reconciled[id] = sel
      else changed = true
    }
    if (changed) set({ interactiveNodes: reconciled })
  },
})

export const useBuildsStore = create(
  persist(createStore, {
    name: 'comparebuilds-state',
    version: 1,
    // Throw (rather than return undefined) when Web Storage is unavailable so
    // createJSONStorage disables persistence cleanly instead of building a
    // wrapper around an undefined store. This keeps the Node test environment,
    // where `localStorage` is not a real Storage, from crashing on writes.
    storage: createJSONStorage(() => {
      if (typeof localStorage === 'undefined' || !localStorage) {
        throw new Error('localStorage unavailable')
      }
      return localStorage
    }),
    // Persist only the small, serialisable slices. treeData/classNodes/
    // parsedBuilds are derived and rebuilt on rehydration via rehydrateTreeData.
    partialize: (state) => ({
      buildStrings: state.buildStrings,
      specId: state.specId,
      classId: state.classId,
      interactiveNodes: state.interactiveNodes,
      addingBuild: state.addingBuild,
    }),
    // Forward-compat hook: if the persisted shape ever changes, bump `version`
    // above and translate older payloads here. v1 is the initial shape, so this
    // is a passthrough; returning the state unchanged keeps current saves valid.
    migrate: (persisted) => persisted,
  }),
)

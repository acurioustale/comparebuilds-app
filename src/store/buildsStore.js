import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { parseSpecId, collectClassNodes } from "../lib/buildString";
import { buildGrantedSeed } from "../lib/treeLogic";
import { wireLayout } from "../lib/wireLayout";
import {
  sanitizeHeroSubtrees,
  findClassForSpec,
  importClassData,
  parseAll,
} from "./storeHelpers";
// NOTE: these limits are mirrored server-side in api/share.php (MAX_BUILDS,
// MAX_BUILD_LEN). Keep the two in sync — the server rejects anything past them, so
// validating here too just gives a clearer message before the share round-trip.
export const MAX_BUILDS = 5;
export const MAX_BUILD_LEN = 2000;
// Per-slot name cap. Mirrored server-side in api/share.php (MAX_LABEL_LEN).
export const MAX_BUILD_NAME_LEN = 40;

// ─── Async tree-data loader (module-level to cancel stale loads) ──────────────

// Incremented every time a new load starts. The load callback checks this
// before committing results so a clearAllBuilds() or rapid spec-switch
// never applies stale data.
let loadGen = 0;

// Serialises addBuild() calls. addBuild reads buildStrings, then commits across
// an await (the first build's dynamic import); two calls dispatched before the
// first commits would both see an empty list, both take the isFirst branch, and
// clobber each other's array write and specId. Chaining each call after the
// previous one keeps that read-modify-write atomic.
let addBuildQueue = Promise.resolve();

async function loadTreeData(
  set,
  get,
  classSlug,
  specSlug,
  specId,
  { preserveInteractive = false } = {},
) {
  const gen = ++loadGen;
  set({ isLoading: true, error: null });

  try {
    const classData = await importClassData(classSlug);

    // Bail if the store was reset or re-targeted while we were awaiting
    if (loadGen !== gen) return;

    const classNodes = collectClassNodes(classData);
    const treeData = classData.specs[specSlug];

    if (!treeData) {
      throw new Error(
        `Spec "${specSlug}" not found in class data for "${classSlug}"`,
      );
    }

    const currentStrings = get().buildStrings;
    // Class-level wire-layout fingerprint: the same hash the snapshot pins, and
    // the detect-only patch stamp embedded in share links. Class-level (not
    // treeData/spec-level) so it also moves when a sibling spec shifts the
    // shared bit layout.
    const layoutHash = wireLayout(classData).hash;
    set({
      classNodes,
      treeData,
      layoutHash,
      isLoading: false,
      // Re-parse every string that may have arrived while we were loading
      parsedBuilds: parseAll(currentStrings, classNodes),
      // In interactive mode (no imported builds), seed pre-granted nodes so
      // prerequisite checks evaluate against the full effective selection set.
      // Skipped on rehydration (preserveInteractive), where the persisted
      // in-progress selection must survive the reload.
      ...(currentStrings.length === 0 &&
        !preserveInteractive && {
          interactiveNodes: buildGrantedSeed(treeData),
        }),
    });
  } catch (err) {
    if (loadGen !== gen) return;
    console.error(`Failed to load tree data: ${err.message}`, err);
    set({
      isLoading: false,
      error: `Failed to load tree data: ${err.message}`,
    });
  }
}

// ─── Initial state snapshot (reused for resets) ──────────────────────────────

const EMPTY = {
  /** @type {string[]} Raw base64 build strings (0 – MAX_BUILDS). */
  buildStrings: [],

  /**
   * User-assigned slot names, parallel to buildStrings. '' = unnamed (the UI
   * shows a computed default). Persisted and carried through both share types.
   * @type {string[]}
   */
  buildNames: [],

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

  /**
   * Index of the build currently being edited in the interactive tree, or null.
   */
  editingIndex: null,

  /** @type {string|null} Structural hash of the active spec tree. */
  layoutHash: null,

  /** @type {string|null} Structural hash restored from a share link. */
  sharedLayoutHash: null,
};

// ─── Store ────────────────────────────────────────────────────────────────────

const createStore = (set, get) => ({
  ...EMPTY,

  setSharedLayoutHash: (hash) => set({ sharedLayoutHash: hash ?? null }),

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
   * Serialised through addBuildQueue so concurrent calls can't race on the
   * empty-list / isFirst path; returns a promise that resolves when this call
   * (and only this call) has finished committing.
   *
   * @param {string} buildString
   */
  addBuild: (buildString) => {
    const run = addBuildQueue.then(() => get().addBuildInternal(buildString));
    // Keep the queue alive even if this call rejects, so later calls still run.
    addBuildQueue = run.catch(() => {});
    return run;
  },

  /** @internal The real addBuild body; always invoked via the serialised addBuild. */
  addBuildInternal: async (buildString) => {
    // Clear stale error at the start of each attempt
    set({ error: null });

    if (!buildString || typeof buildString !== "string") {
      set({ error: "Build string must be a non-empty string." });
      return;
    }

    if (buildString.length > MAX_BUILD_LEN) {
      set({
        error: `Build string is too long (max ${MAX_BUILD_LEN} characters).`,
      });
      return;
    }

    const {
      buildStrings,
      specId: currentSpecId,
      classNodes,
      isLoading,
    } = get();

    if (buildStrings.length >= MAX_BUILDS) {
      set({ error: `You can compare at most ${MAX_BUILDS} builds at once.` });
      return;
    }

    // Reject exact duplicates — comparing a build against itself is pointless,
    // and identical strings would collide as React keys in the slot list.
    if (buildStrings.includes(buildString)) {
      set({ error: "That build has already been added." });
      return;
    }

    // ── Parse just the 24-bit header to identify the spec ────────────────────
    let header;
    try {
      header = parseSpecId(buildString);
    } catch (err) {
      // Surface the specific reason for an unsupported version; otherwise treat it
      // as an unreadable header (bad base64, truncation, etc.).
      console.error(
        `Failed to parse spec ID from build string: ${err.message}`,
        err,
      );
      const isVersion =
        err instanceof RangeError && /version/i.test(err.message);
      set({
        error: isVersion
          ? `${err.message}. This build string is from a newer game format than this tool supports.`
          : "Could not read the build string header — it may be truncated or corrupt.",
      });
      return;
    }

    const match = findClassForSpec(header.specId);
    if (!match) {
      set({
        error:
          `Spec ID ${header.specId} was not found in the local class index. ` +
          `Try re-running the ingest script for the latest data.`,
      });
      return;
    }

    // ── Reject spec mismatches ────────────────────────────────────────────────
    if (currentSpecId !== null && header.specId !== currentSpecId) {
      const existingMatch = findClassForSpec(currentSpecId);
      const existingLabel = existingMatch
        ? `${existingMatch.cls.displayName} — ${existingMatch.spec.displayName}`
        : `spec ${currentSpecId}`;
      const incomingLabel = `${match.cls.displayName} — ${match.spec.displayName}`;
      set({
        error:
          `Spec mismatch: loaded builds are ${existingLabel}, ` +
          `but this string is for ${incomingLabel}.`,
      });
      return;
    }

    // ── Append the string ─────────────────────────────────────────────────────
    const isFirst = buildStrings.length === 0;
    const newStrings = [...buildStrings, buildString];
    // Append a null placeholder — becomes a real result once classNodes land
    const newParsed = [...get().parsedBuilds, null];
    // Keep names parallel; new slots start unnamed.
    const newNames = [...get().buildNames, ""];

    if (isFirst) {
      // Set identity + kick off tree-data load (specId set synchronously so
      // concurrent addBuild calls can see it before the await resolves)
      set({
        buildStrings: newStrings,
        parsedBuilds: newParsed,
        buildNames: newNames,
        specId: header.specId,
        classId: match.cls.id,
      });
      await loadTreeData(
        set,
        get,
        match.cls.name,
        match.spec.name,
        header.specId,
      );
    } else if (classNodes && !isLoading) {
      // Tree data already available — parse the new string immediately
      set({
        buildStrings: newStrings,
        parsedBuilds: parseAll(newStrings, classNodes),
        buildNames: newNames,
      });
    } else if (isLoading) {
      // Tree data is mid-load — store the string now; the load callback will
      // call parseAll(get().buildStrings, …) when it finishes, picking this up
      set({
        buildStrings: newStrings,
        parsedBuilds: newParsed,
        buildNames: newNames,
      });
    } else {
      // Not loading and tree data never landed — the first load must have
      // failed. Store the string and (re)start the load so it gets parsed
      // instead of being stranded as a permanent null placeholder.
      set({
        buildStrings: newStrings,
        parsedBuilds: newParsed,
        buildNames: newNames,
      });
      await loadTreeData(
        set,
        get,
        match.cls.name,
        match.spec.name,
        header.specId,
      );
    }

    // Resolves truthy on success and falsy on failure (an error path returned
    // early above), so the interactive export can tell a committed build from a
    // rejected one (e.g. a duplicate) instead of always flashing "added".
    return !get().error;
  },

  /**
   * Removes the build at the given index. Resets all state if the last build
   * is removed so the next addBuild() can start fresh with a different spec.
   *
   * @param {number} index
   */
  removeBuild: (index) => {
    const { buildStrings, parsedBuilds, buildNames } = get();
    if (index < 0 || index >= buildStrings.length) return;

    const newStrings = buildStrings.filter((_, i) => i !== index);
    const newParsed = parsedBuilds.filter((_, i) => i !== index);
    const newNames = buildNames.filter((_, i) => i !== index);

    if (newStrings.length === 0) {
      // Invalidate any in-flight load so its commit is a no-op
      loadGen++;
      set({ ...EMPTY });
    } else {
      set({
        buildStrings: newStrings,
        parsedBuilds: newParsed,
        buildNames: newNames,
      });
    }
  },

  /**
   * Removes all builds and resets every piece of state to its initial value.
   */
  clearAllBuilds: () => {
    loadGen++; // cancel any in-flight load
    set({ ...EMPTY });
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
    if (get().buildStrings.length > 0) return;

    // Already on this spec with its tree loaded — re-selecting it (e.g. clicking
    // the current spec in the dropdown) must not wipe an in-progress interactive
    // selection by reseeding it back to the granted seed.
    if (get().specId === specId && get().treeData) return;

    const match = findClassForSpec(specId);
    if (!match) return;

    set({ specId, classId: null, interactiveNodes: {}, error: null });
    await loadTreeData(set, get, match.cls.name, match.spec.name, specId);
  },

  /**
   * Replaces the interactive node selection wholesale. Called by
   * InteractiveTalentTree on every click.
   *
   * @param {Record<number, {pointsInvested: number, entryChosen: number|null}>} nodes
   */
  setInteractiveNodes: (nodes) => {
    const { treeData } = get();
    set({ interactiveNodes: sanitizeHeroSubtrees(nodes, treeData) });
  },

  /**
   * Enter "add another build" mode: clears the interactive node selection back
   * to the granted seed and shows the interactive tree alongside the comparison.
   */
  startAddingBuild: () => {
    const { treeData } = get();
    if (!treeData) return;
    set({ addingBuild: true, interactiveNodes: buildGrantedSeed(treeData) });
  },

  /** Called after a successful interactive export to hide the interactive tree. */
  finishAddingBuild: () => set({ addingBuild: false, editingIndex: null }),

  /**
   * Opens the build at `index` in the interactive calculator, seeded with its selections.
   * @param {number} index
   */
  editBuild: (index) => {
    const { treeData, parsedBuilds } = get();
    if (!treeData || !parsedBuilds[index]) return;
    set({ addingBuild: true, editingIndex: index });
    get().setInteractiveNodes({
      ...buildGrantedSeed(treeData),
      ...parsedBuilds[index].nodes,
    });
  },

  /**
   * Replaces the build string at `index` with `buildString`, re-parses, and preserves its name.
   * @param {number} index
   * @param {string} buildString
   */
  replaceBuild: (index, buildString) => {
    const run = addBuildQueue.then(() =>
      get().replaceBuildInternal(index, buildString),
    );
    addBuildQueue = run.catch(() => {});
    return run;
  },

  replaceBuildInternal: async (index, buildString) => {
    set({ error: null });

    if (!buildString || typeof buildString !== "string") {
      set({ error: "Build string must be a non-empty string." });
      return;
    }

    if (buildString.length > MAX_BUILD_LEN) {
      set({
        error: `Build string is too long (max ${MAX_BUILD_LEN} characters).`,
      });
      return;
    }

    const {
      buildStrings,
      specId: currentSpecId,
      classNodes,
      isLoading,
    } = get();

    if (index < 0 || index >= buildStrings.length) return;

    if (buildStrings.some((s, i) => i !== index && s === buildString)) {
      set({ error: "That build has already been added." });
      return;
    }

    let header;
    try {
      header = parseSpecId(buildString);
    } catch (err) {
      console.error(
        `Failed to parse spec ID from build string: ${err.message}`,
        err,
      );
      const isVersion =
        err instanceof RangeError && /version/i.test(err.message);
      set({
        error: isVersion
          ? `${err.message}. This build string is from a newer game format than this tool supports.`
          : "Could not read the build string header — it may be truncated or corrupt.",
      });
      return;
    }

    if (currentSpecId !== null && header.specId !== currentSpecId) {
      const match = findClassForSpec(header.specId);
      const existingMatch = findClassForSpec(currentSpecId);
      const existingLabel = existingMatch
        ? `${existingMatch.cls.displayName} — ${existingMatch.spec.displayName}`
        : `spec ${currentSpecId}`;
      const incomingLabel = match
        ? `${match.cls.displayName} — ${match.spec.displayName}`
        : `spec ${header.specId}`;
      set({
        error:
          `Spec mismatch: loaded builds are ${existingLabel}, ` +
          `but this string is for ${incomingLabel}.`,
      });
      return;
    }

    const newStrings = [...buildStrings];
    newStrings[index] = buildString;

    if (classNodes && !isLoading) {
      set({
        buildStrings: newStrings,
        parsedBuilds: parseAll(newStrings, classNodes),
      });
    } else {
      set({
        buildStrings: newStrings,
      });
    }

    // Mirror addBuildInternal's contract: truthy on success, falsy on failure.
    return !get().error;
  },

  /**
   * Renames the slot at `index`. Trimmed to MAX_BUILD_NAME_LEN; '' means unnamed.
   * @param {number} index
   * @param {string} name
   */
  setBuildName: (index, name) => {
    const { buildStrings, buildNames } = get();
    if (index < 0 || index >= buildStrings.length) return;
    const next = [...buildNames];
    next[index] = String(name ?? "").slice(0, MAX_BUILD_NAME_LEN);
    set({ buildNames: next });
  },

  /**
   * Replaces all slot names at once (used when applying a shared build's
   * labels). Normalised to the current buildStrings length.
   * @param {string[]} names
   */
  setBuildNames: (names) => {
    const { buildStrings } = get();
    const src = Array.isArray(names) ? names : [];
    set({
      buildNames: buildStrings.map((_, i) =>
        typeof src[i] === "string" ? src[i].slice(0, MAX_BUILD_NAME_LEN) : "",
      ),
    });
  },

  /**
   * Rebuilds the derived, non-persisted state (treeData, classNodes,
   * parsedBuilds) after the persisted slices have been rehydrated from
   * localStorage. Reads specId from the restored state, loads the matching
   * class tree, and re-parses any restored build strings. The in-progress
   * interactive selection is preserved (preserveInteractive) rather than reset
   * to the granted seed. No-op when nothing was restored.
   */
  rehydrateTreeData: async () => {
    const { specId } = get();
    if (specId == null) return;

    const match = findClassForSpec(specId);
    // The persisted spec no longer exists in the data (e.g. a game patch or a
    // data regen removed it). Don't strand the user on saved-but-unloadable
    // builds — clear back to a clean slate.
    if (!match) {
      loadGen++;
      set({ ...EMPTY });
      return;
    }

    await loadTreeData(set, get, match.cls.name, match.spec.name, specId, {
      preserveInteractive: true,
    });

    // If the load failed, the restored build strings can never render — discard
    // the stale persisted state rather than leaving a tree-less dead end.
    if (!get().treeData) {
      loadGen++;
      set({ ...EMPTY });
      return;
    }

    // Keep names parallel to builds even if an older/partial persisted payload
    // had a mismatched length.
    const { buildStrings, buildNames } = get();
    if (buildNames.length !== buildStrings.length) {
      set({ buildNames: buildStrings.map((_, i) => buildNames[i] ?? "") });
    }

    // Drop any restored interactive selections for nodes that no longer exist in
    // the loaded tree, so a stale persisted id can't linger in the selection.
    const known = new Set(get().treeData.nodes.map((n) => n.id));
    const current = get().interactiveNodes;
    const reconciled = {};
    let changed = false;
    for (const [id, sel] of Object.entries(current)) {
      if (known.has(Number(id))) reconciled[id] = sel;
      else changed = true;
    }
    if (changed) set({ interactiveNodes: reconciled });
  },
});

export const useBuildsStore = create(
  persist(createStore, {
    name: "comparebuilds-state",
    version: 1,
    // Throw (rather than return undefined) when Web Storage is unavailable so
    // createJSONStorage disables persistence cleanly instead of building a
    // wrapper around an undefined store. This keeps the Node test environment,
    // where `localStorage` is not a real Storage, from crashing on writes.
    //
    // When it IS available, wrap writes: a real browser's localStorage can still
    // throw at write time (quota exceeded, or Safari private mode), and that throw
    // would otherwise surface inside a state update. Swallow it so persistence
    // degrades to best-effort ("not saved this session") instead of breaking the
    // app. Reads pass straight through — getItem does not throw in these modes.
    storage: createJSONStorage(() => {
      if (typeof localStorage === "undefined" || !localStorage) {
        throw new Error("localStorage unavailable");
      }
      return {
        getItem: (name) => localStorage.getItem(name),
        setItem: (name, value) => {
          try {
            localStorage.setItem(name, value);
          } catch (err) {
            console.error(
              `[zustand persist middleware] Failed to save state to localStorage: ${err.message}`,
              err,
            );
            // Best-effort: a failed write must not break a state update.
          }
        },
        removeItem: (name) => localStorage.removeItem(name),
      };
    }),
    // Persist only the small, serialisable slices. treeData/classNodes/
    // parsedBuilds are derived and rebuilt on rehydration via rehydrateTreeData.
    partialize: (state) => ({
      buildStrings: state.buildStrings,
      buildNames: state.buildNames,
      specId: state.specId,
      classId: state.classId,
      interactiveNodes: state.interactiveNodes,
      addingBuild: state.addingBuild,
      editingIndex: state.editingIndex,
    }),
    // Forward-compat hook: if the persisted shape ever changes, bump `version`
    // above and translate older payloads here. v1 is the initial shape, so this
    // is a passthrough; returning the state unchanged keeps current saves valid.
    migrate: (persisted) => persisted,
  }),
);

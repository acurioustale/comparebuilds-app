import {
  findClassForSpec,
  parseAll,
  readBuildHeader,
  specMismatchError,
} from "../storeHelpers";
import {
  MAX_BUILDS,
  MAX_BUILD_LEN,
  MAX_BUILD_NAME_LEN,
  EMPTY,
} from "./constants";
import { loadTreeData } from "./loadTreeData";
import {
  entriesForSpec,
  loadTopBuilds,
  selectTopBuilds,
  topBuildLabel,
} from "../../lib/topBuilds";

export const createBuildsSlice = (set, get) => ({
  addBuildQueue: Promise.resolve(),
  slotGen: 0,

  /**
   * @param {string|null} hash Layout hash string or null
   * @returns {void}
   */
  setSharedLayoutHash: (hash) => set({ sharedLayoutHash: hash ?? null }),

  /**
   * Copies the persisted session slices — exactly the fields `partialize` in
   * buildsStore.js writes to localStorage — so a caller that is about to clear
   * the store speculatively can put the session back if the thing it cleared
   * for never arrives. The share route is the one such caller: it must empty
   * the store before it knows whether any build in the link will load.
   *
   * @returns {object} An opaque snapshot for restoreSession.
   */
  captureSession: () => {
    const s = get();
    return {
      buildStrings: [...s.buildStrings],
      buildNames: [...s.buildNames],
      specId: s.specId,
      classId: s.classId,
      interactiveNodes: { ...s.interactiveNodes },
      addingBuild: s.addingBuild,
      editingIndex: s.editingIndex,
    };
  },

  /**
   * Puts back a snapshot from captureSession, resetting everything else to its
   * initial value. Derived state (treeData, classNodes, parsedBuilds) is NOT
   * rebuilt here — the caller follows with rehydrateTreeData, exactly as the
   * plain-local route does after persist restores these same slices.
   *
   * @param {object} snapshot
   * @returns {void}
   */
  restoreSession: (snapshot) => {
    set({
      ...EMPTY,
      ...snapshot,
      // Cancel any load the abandoned attempt started, and invalidate anything
      // it queued against the slot indices we are replacing.
      loadGen: get().loadGen + 1,
      slotGen: get().slotGen + 1,
    });
  },

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
   * Captures slotGen at call time and skips if a structural edit (clearAllBuilds
   * / removeBuild) reindexed the slots while this add waited in the queue — same
   * guard as replaceBuild. Without it, a clear or remove that races an in-flight
   * add would let the queued add run against the emptied store, take the isFirst
   * path, and resurrect a build the user explicitly cleared.
   *
   * @param {string} buildString
   * @returns {Promise<boolean>} Resolves true on success, false on failure
   */
  addBuild: (buildString) => {
    const gen = get().slotGen;
    const queue = get().addBuildQueue;
    const run = queue.then(() => {
      if (get().slotGen !== gen) return false;
      return get().addBuildInternal(buildString);
    });
    // Keep the queue alive even if this call rejects, so later calls still run.
    set({ addBuildQueue: run.catch(() => {}) });
    return run;
  },

  /**
   * @internal The real addBuild body; always invoked via the serialised addBuild.
   * @param {string} buildString
   * @returns {Promise<boolean>}
   */
  addBuildInternal: async (buildString) => {
    // Clear stale error at the start of each attempt
    set({ error: null });

    if (!buildString || typeof buildString !== "string") {
      set({ error: "Build string must be a non-empty string." });
      return false;
    }

    if (buildString.length > MAX_BUILD_LEN) {
      set({
        error: `Build string is too long (max ${MAX_BUILD_LEN} characters).`,
      });
      return false;
    }

    const {
      buildStrings,
      specId: currentSpecId,
      classNodes,
      isLoading,
    } = get();

    if (buildStrings.length >= MAX_BUILDS) {
      set({ error: `You can compare at most ${MAX_BUILDS} builds at once.` });
      return false;
    }

    // Reject exact duplicates — comparing a build against itself is pointless,
    // and identical strings would collide as React keys in the slot list. Only
    // once the tree has loaded (or is loading), though: in the stranded state
    // (a prior first-build load failed, so classNodes is null and nothing is
    // loading) the committed slot is an unparsed placeholder whose Edit button
    // is hidden, so re-pasting the same string is the user's natural retry.
    // Let it fall through to the reload branch below rather than dead-end here.
    if ((classNodes || isLoading) && buildStrings.includes(buildString)) {
      set({ error: "That build has already been added." });
      return false;
    }

    // ── Parse just the 24-bit header to identify the spec ────────────────────
    const { header, error: headerError } = readBuildHeader(buildString);
    if (headerError) {
      set({ error: headerError });
      return false;
    }

    const match = findClassForSpec(header.specId);
    if (!match) {
      set({
        error:
          `Spec ID ${header.specId} was not found in the local class index. ` +
          `Try re-running the ingest script for the latest data.`,
      });
      return false;
    }

    // ── Reject spec mismatches ────────────────────────────────────────────────
    // Only an already-committed build constrains the spec. With no builds yet,
    // a fresh import is allowed to (re)target the spec via the first-build flow
    // — so an interactive preloadSpec's optimistic specId can't reject it as a
    // mismatch during the tree-data load that follows the preload.
    if (
      buildStrings.length > 0 &&
      currentSpecId !== null &&
      header.specId !== currentSpecId
    ) {
      set({ error: specMismatchError(currentSpecId, header.specId) });
      return false;
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
        parsedBuilds: parseAll(newStrings, classNodes, get().treeData),
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
      // instead of being stranded as a permanent null placeholder. A retry of
      // an already-stranded slot (same string) reloads in place rather than
      // appending a second copy.
      const isRetry = buildStrings.includes(buildString);
      set({
        buildStrings: isRetry ? buildStrings : newStrings,
        parsedBuilds: isRetry ? get().parsedBuilds : newParsed,
        buildNames: isRetry ? get().buildNames : newNames,
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
   * @returns {void}
   */
  removeBuild: (index) => {
    const {
      buildStrings,
      parsedBuilds,
      buildNames,
      editingIndex,
      addingBuild,
      specId,
      classId,
      treeData,
      classNodes,
      layoutHash,
      interactiveNodes,
    } = get();
    if (index < 0 || index >= buildStrings.length) return;

    // Reindexing the slots invalidates any positional index captured by a
    // replaceBuild still waiting in addBuildQueue.
    const nextSlotGen = get().slotGen + 1;
    set({ slotGen: nextSlotGen });

    const newStrings = buildStrings.filter((_, i) => i !== index);
    const newParsed = parsedBuilds.filter((_, i) => i !== index);
    const newNames = buildNames.filter((_, i) => i !== index);

    if (newStrings.length === 0) {
      // Removing the last build normally resets to the class grid. But an
      // interactive session can be on screen at the same time — MainView
      // renders the calculator alongside the comparison whenever addingBuild is
      // set — and that selection belongs to the user, not to the slot they just
      // removed. Discarding a half-finished build because an unrelated imported
      // one was deleted is data loss, and this branch was the only place that
      // did it: the sibling below is careful to preserve editingIndex and
      // addingBuild.
      //
      // Removing the slot being EDITED is the exception: those selections are
      // that build's, seeded from it by editBuild, so they go with it — the
      // same call the sibling's editShift makes.
      //
      // The keep list deliberately omits sharedLayoutHash. What survives here
      // came from the calculator, not from a share, so a share's hash must not
      // outlive it and flag it as an earlier talent revision.
      const keepInteractive = addingBuild && editingIndex !== index;
      set({
        ...EMPTY,
        // Invalidate any in-flight load so its commit is a no-op
        loadGen: get().loadGen + 1,
        ...(keepInteractive
          ? {
              specId,
              classId,
              treeData,
              classNodes,
              layoutHash,
              interactiveNodes,
              addingBuild: true,
              // Only one slot existed, so any surviving index is stale.
              editingIndex: null,
            }
          : {}),
      });
    } else {
      // Keep editingIndex pointing at the build it referenced, same as
      // swapBuilds. Removing the edited slot exits edit mode (its selections no
      // longer have a home); removing a lower slot shifts the edited build down
      // by one. Without this the export path (useBuildExport) would replaceBuild
      // a stale index — overwriting the wrong slot or silently dropping the edit.
      const editShift =
        editingIndex == null || editingIndex < index
          ? { editingIndex }
          : editingIndex === index
            ? { editingIndex: null, addingBuild: false }
            : { editingIndex: editingIndex - 1 };
      set({
        buildStrings: newStrings,
        parsedBuilds: newParsed,
        buildNames: newNames,
        ...editShift,
      });
    }
  },

  /**
   * Swaps the builds at two slot indices (string, parsed result, and name
   * travel together). Used by the 2-build diff's baseline-swap control to
   * flip which build renders as A vs B — a pure slot-order change, so the
   * diff/comparison logic downstream is untouched.
   *
   * @param {number} indexA
   * @param {number} indexB
   * @returns {void}
   */
  swapBuilds: (indexA, indexB) => {
    const { buildStrings, parsedBuilds, buildNames, editingIndex } = get();
    if (
      indexA === indexB ||
      indexA < 0 ||
      indexB < 0 ||
      indexA >= buildStrings.length ||
      indexB >= buildStrings.length
    )
      return;

    // Reindexing invalidates any positional index captured by a replaceBuild
    // still waiting in addBuildQueue, same as removeBuild. Bump loadGen too so a
    // swap cancels any in-flight loadTreeData, matching removeBuild/clearAllBuilds:
    // today the swap control isn't reachable mid-load, but keeping the structural
    // mutations' cancel-the-load contract uniform removes the latent trap where a
    // load committing against a captured pre-swap snapshot would desync the arrays.
    //
    // Clearing isLoading is part of that contract. A cancelled load returns at
    // its generation check without touching the flag — correct when the canceller
    // starts a replacement load that will own it (removeBuild/clearAllBuilds reset
    // via EMPTY), but a swap starts none, so leaving it set would strand the UI in
    // a spinner that nothing can clear.
    set({
      loadGen: get().loadGen + 1,
      slotGen: get().slotGen + 1,
      isLoading: false,
    });

    const swapAt = (arr) => {
      const next = [...arr];
      [next[indexA], next[indexB]] = [next[indexB], next[indexA]];
      return next;
    };

    set({
      buildStrings: swapAt(buildStrings),
      parsedBuilds: swapAt(parsedBuilds),
      buildNames: swapAt(buildNames),
      editingIndex:
        editingIndex === indexA
          ? indexB
          : editingIndex === indexB
            ? indexA
            : editingIndex,
    });
  },

  /**
   * Removes all builds and resets every piece of state to its initial value.
   * @returns {void}
   */
  clearAllBuilds: () => {
    // cancel any in-flight load and invalidate any queued replaceBuild
    set({ ...EMPTY, loadGen: get().loadGen + 1, slotGen: get().slotGen + 1 });
  },

  /**
   * Replaces the build string at `index` with `buildString`, re-parses, and preserves its name.
   * @param {number} index
   * @param {string} buildString
   * @returns {Promise<boolean>}
   */
  replaceBuild: (index, buildString) => {
    const gen = get().slotGen;
    const queue = get().addBuildQueue;
    const run = queue.then(() => {
      // A structural edit (removeBuild / clearAllBuilds) reindexed the slots
      // after this replace was queued, so the captured index is stale — skip
      // rather than overwrite the wrong slot.
      if (get().slotGen !== gen) return false;
      return get().replaceBuildInternal(index, buildString);
    });
    set({ addBuildQueue: run.catch(() => {}) });
    return run;
  },

  /**
   * @param {number} index
   * @param {string} buildString
   * @returns {Promise<boolean>}
   */
  replaceBuildInternal: async (index, buildString) => {
    set({ error: null });

    if (!buildString || typeof buildString !== "string") {
      set({ error: "Build string must be a non-empty string." });
      return false;
    }

    if (buildString.length > MAX_BUILD_LEN) {
      set({
        error: `Build string is too long (max ${MAX_BUILD_LEN} characters).`,
      });
      return false;
    }

    const {
      buildStrings,
      specId: currentSpecId,
      classNodes,
      isLoading,
    } = get();

    if (index < 0 || index >= buildStrings.length) return false;

    if (buildStrings.some((s, i) => i !== index && s === buildString)) {
      set({ error: "That build has already been added." });
      return false;
    }

    const { header, error: headerError } = readBuildHeader(buildString);
    if (headerError) {
      set({ error: headerError });
      return false;
    }

    if (currentSpecId !== null && header.specId !== currentSpecId) {
      set({ error: specMismatchError(currentSpecId, header.specId) });
      return false;
    }

    const newStrings = [...buildStrings];
    newStrings[index] = buildString;

    if (classNodes && !isLoading) {
      // Tree data already available — re-parse the whole slot list immediately.
      set({
        buildStrings: newStrings,
        parsedBuilds: parseAll(newStrings, classNodes, get().treeData),
      });
    } else if (isLoading) {
      // Tree data is mid-load — store the string now; the in-flight load's
      // completion re-parses get().buildStrings, picking this replacement up.
      set({
        buildStrings: newStrings,
      });
    } else {
      // Not loading and tree data never landed — the first load must have
      // failed. Store the string and (re)start the load so the replaced slot
      // gets parsed instead of being stranded as a permanent null placeholder.
      // Mirrors addBuildInternal's failed-load recovery branch.
      const match = findClassForSpec(header.specId);
      if (!match) {
        set({
          error:
            `Spec ID ${header.specId} was not found in the local class index. ` +
            `Try re-running the ingest script for the latest data.`,
        });
        return false;
      }
      set({
        buildStrings: newStrings,
      });
      await loadTreeData(
        set,
        get,
        match.cls.name,
        match.spec.name,
        header.specId,
      );
    }

    // Mirror addBuildInternal's contract: truthy on success, falsy on failure.
    return !get().error;
  },

  /**
   * Renames the slot at `index`. Trimmed to MAX_BUILD_NAME_LEN; '' means unnamed.
   * @param {number} index
   * @param {string} name
   * @returns {void}
   */
  setBuildName: (index, name) => {
    const { buildStrings, buildNames } = get();
    if (index < 0 || index >= buildStrings.length) return;
    const next = [...buildNames];
    next[index] = String(name ?? "").slice(0, MAX_BUILD_NAME_LEN);
    set({ buildNames: next });
  },

  /**
   * Fills the free slots with the most-repeated talent strings among Raidbots'
   * top sims for the loaded spec (see src/lib/topBuilds.js).
   *
   * Adds through the ordinary addBuild path rather than writing slots directly,
   * so these builds are validated, spec-checked, deduplicated and parsed on
   * exactly the same terms as a pasted one — a reference build is not a
   * privileged kind of build, and a second code path into the slot list is how
   * the two would drift.
   *
   * Adds are sequential and deliberately so: addBuild is serialised on its own
   * queue and the FIRST one triggers the class-data import that the rest need.
   * Stops early if any add is rejected, leaving that slot's error in place
   * rather than piling further failures on top of it.
   *
   * @returns {Promise<number>} how many builds were actually added
   */
  addTopBuilds: async () => {
    set({ error: null });
    const { specId, buildStrings } = get();
    if (specId == null) {
      set({ error: "Pick a class and spec first." });
      return 0;
    }

    let table;
    try {
      table = await loadTopBuilds();
    } catch (err) {
      console.error(`Failed to load the top-sims table: ${err.message}`, err);
      set({ error: "Could not load the reference builds." });
      return 0;
    }

    const picks = selectTopBuilds({
      entries: entriesForSpec(table, specId),
      existing: buildStrings,
      limit: MAX_BUILDS - buildStrings.length,
    });
    if (picks.length === 0) {
      // Nothing to add is not a failure. It means either the spec has no sim
      // data (routine — the sample is DPS-heavy, so healers and tanks are thin)
      // or every entry is already loaded.
      return 0;
    }

    let added = 0;
    for (const pick of picks) {
      if (!(await get().addBuild(pick.talents))) break;
      // Name the slot by its position in the table, not by the slot index, so
      // the label keeps meaning what it says when these sit beside pasted
      // builds.
      get().setBuildName(get().buildStrings.length - 1, topBuildLabel(pick));
      added++;
    }
    return added;
  },

  /**
   * Replaces all slot names at once (used when applying a shared build's
   * labels). Normalised to the current buildStrings length.
   * @param {string[]} names
   * @returns {void}
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
});

import { parseSpecId } from "../../lib/buildString";
import { findClassForSpec, parseAll } from "../storeHelpers";
import {
  MAX_BUILDS,
  MAX_BUILD_LEN,
  MAX_BUILD_NAME_LEN,
  EMPTY,
} from "./constants";
import { loadTreeData } from "./loadTreeData";

export const createBuildsSlice = (set, get) => ({
  addBuildQueue: Promise.resolve(),
  slotGen: 0,

  /**
   * @param {string|null} hash Layout hash string or null
   * @returns {void}
   */
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
   * @returns {Promise<boolean>} Resolves true on success, false on failure
   */
  addBuild: (buildString) => {
    const queue = get().addBuildQueue;
    const run = queue.then(() => get().addBuildInternal(buildString));
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
    // Only an already-committed build constrains the spec. With no builds yet,
    // a fresh import is allowed to (re)target the spec via the first-build flow
    // — so an interactive preloadSpec's optimistic specId can't reject it as a
    // mismatch during the tree-data load that follows the preload.
    if (
      buildStrings.length > 0 &&
      currentSpecId !== null &&
      header.specId !== currentSpecId
    ) {
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
   * @returns {void}
   */
  removeBuild: (index) => {
    const { buildStrings, parsedBuilds, buildNames } = get();
    if (index < 0 || index >= buildStrings.length) return;

    // Reindexing the slots invalidates any positional index captured by a
    // replaceBuild still waiting in addBuildQueue.
    const nextSlotGen = get().slotGen + 1;
    set({ slotGen: nextSlotGen });

    const newStrings = buildStrings.filter((_, i) => i !== index);
    const newParsed = parsedBuilds.filter((_, i) => i !== index);
    const newNames = buildNames.filter((_, i) => i !== index);

    if (newStrings.length === 0) {
      // Invalidate any in-flight load so its commit is a no-op
      set({ ...EMPTY, loadGen: get().loadGen + 1 });
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

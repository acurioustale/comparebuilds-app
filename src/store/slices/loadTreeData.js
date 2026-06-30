import { collectClassNodes } from "../../lib/buildString";
import { buildGrantedSeed } from "../../lib/treeLogic";
import { wireLayout } from "../../lib/wireLayout";
import * as storeHelpers from "../storeHelpers";
import { EMPTY } from "./constants";

/**
 * @param {function} set Zustand set function
 * @param {function} get Zustand get function
 * @param {string} classSlug Class slug name
 * @param {string} specSlug Spec slug name
 * @param {number} specId Spec ID
 * @param {{ preserveInteractive?: boolean }} [options] Options object
 * @returns {Promise<void>}
 */
export async function loadTreeData(
  set,
  get,
  classSlug,
  specSlug,
  specId,
  { preserveInteractive = false } = {},
) {
  const gen = get().loadGen + 1;
  // Captured at LOAD START: was this a no-committed-builds (interactive /
  // preload) load, or an import (>=1 build)? Both the success-path reseed and
  // the error-path recovery branch key off this. Reading it fresh after the
  // await would let a build appended mid-load flip the branch — stranding that
  // build with treeData/classNodes still null in the error path. Capturing it
  // here makes the decision independent of any append that races the await.
  const startedWithNoBuilds = get().buildStrings.length === 0;
  set({ isLoading: true, error: null, loadGen: gen });

  try {
    const classData = await storeHelpers.importClassData(classSlug);

    // Bail if the store was reset or re-targeted while we were awaiting
    if (get().loadGen !== gen) return;

    const classNodes = collectClassNodes(classData);
    const treeData = classData.specs[specSlug];

    if (!treeData) {
      throw new Error(
        `Spec "${specSlug}" not found in class data for "${classSlug}"`,
      );
    }

    if (Array.isArray(treeData.nodes)) {
      treeData.nodes.sort((a, b) =>
        a.posY !== b.posY
          ? a.posY - b.posY
          : a.posX !== b.posX
            ? a.posX - b.posX
            : a.id - b.id,
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
      parsedBuilds: storeHelpers.parseAll(currentStrings, classNodes),
      // In interactive mode (no imported builds at load start), seed pre-granted
      // nodes so prerequisite checks evaluate against the full effective
      // selection set. Keyed off the load-start snapshot, not a fresh post-await
      // read, so a build appended mid-load can't flip this. Skipped on
      // rehydration (preserveInteractive), where the persisted in-progress
      // selection must survive the reload.
      ...(startedWithNoBuilds &&
        !preserveInteractive && {
          interactiveNodes: buildGrantedSeed(treeData),
        }),
    });
  } catch (err) {
    if (get().loadGen !== gen) return;
    console.error(`Failed to load tree data: ${err.message}`, err);
    const message = `Failed to load tree data: ${err.message}`;
    // An interactive preload (no build strings at load start) optimistically
    // set specId before this load. On failure, don't leave specId pointing at a
    // tree that never loaded — treeData/classNodes would still hold the previous
    // spec, so the tree would render the old spec while an export stamped the
    // new spec's header onto the old bit layout. Reset to a clean slate so the
    // UI falls back to spec selection. Imports (>=1 build at load start) keep
    // their string and surface the error on the slot, as before. The branch
    // keys off the load-start snapshot, not a fresh get(): a build appended mid-
    // load must not flip this and strand its string with treeData still null.
    if (startedWithNoBuilds) {
      set({ ...EMPTY, error: message });
    } else {
      set({ isLoading: false, error: message });
    }
  }
}

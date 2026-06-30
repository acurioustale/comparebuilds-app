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
    if (get().loadGen !== gen) return;
    console.error(`Failed to load tree data: ${err.message}`, err);
    const message = `Failed to load tree data: ${err.message}`;
    // An interactive preload (no build strings) optimistically set specId
    // before this load. On failure, don't leave specId pointing at a tree that
    // never loaded — treeData/classNodes would still hold the previous spec, so
    // the tree would render the old spec while an export stamped the new spec's
    // header onto the old bit layout. Reset to a clean slate so the UI falls
    // back to spec selection. Imports (≥1 build) keep their string and surface
    // the error on the slot, as before.
    if (get().buildStrings.length === 0) {
      set({ ...EMPTY, error: message });
    } else {
      set({ isLoading: false, error: message });
    }
  }
}

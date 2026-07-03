import { buildGrantedSeed } from "../../lib/treeLogic";
import { findClassForSpec, sanitizeHeroSubtrees } from "../storeHelpers";
import { EMPTY } from "./constants";
import { loadTreeData } from "./loadTreeData";

export const createInteractiveSlice = (set, get) => ({
  /**
   * Loads tree data for the interactive calculator without importing a build
   * string. Only operates when no builds are present. Sets specId so the
   * spec row highlights correctly; leaves classId null so the class grid
   * stays unlocked.
   *
   * @param {number} specId
   * @returns {Promise<void>}
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
   * @returns {void}
   */
  setInteractiveNodes: (nodes) => {
    const { treeData } = get();
    set({ interactiveNodes: sanitizeHeroSubtrees(nodes, treeData) });
  },

  /**
   * Enter "add another build" mode: clears the interactive node selection back
   * to the granted seed and shows the interactive tree alongside the comparison.
   * @returns {void}
   */
  startAddingBuild: () => {
    const { treeData } = get();
    if (!treeData) return;
    set({ addingBuild: true, interactiveNodes: buildGrantedSeed(treeData) });
  },

  /**
   * Called after a successful interactive export to hide the interactive tree.
   * @returns {void}
   */
  finishAddingBuild: () => set({ addingBuild: false, editingIndex: null }),

  /**
   * Opens the build at `index` in the interactive calculator, seeded with its selections.
   * @param {number} index
   * @returns {void}
   */
  editBuild: (index) => {
    const { treeData, parsedBuilds } = get();
    if (!treeData || !parsedBuilds[index]) return;
    set({ addingBuild: true, editingIndex: index });
    // parsedBuilds[index].nodes carries the synthetic heroGateNodeId, which is
    // not a real tree node. Seed only with ids the tree actually contains so a
    // non-node id can't linger in the interactive selection (and persist to
    // localStorage, where rehydrate would then silently strip it).
    const known = new Set(treeData.nodes.map((n) => n.id));
    const seed = { ...buildGrantedSeed(treeData) };
    for (const [id, sel] of Object.entries(parsedBuilds[index].nodes)) {
      if (known.has(Number(id))) seed[id] = sel;
    }
    get().setInteractiveNodes(seed);
  },

  /**
   * Rebuilds the derived, non-persisted state (treeData, classNodes,
   * parsedBuilds) after the persisted slices have been rehydrated from
   * localStorage. Reads specId from the restored state, loads the matching
   * class tree, and re-parses any restored build strings. The in-progress
   * interactive selection is preserved (preserveInteractive) rather than reset
   * to the granted seed. No-op when nothing was restored.
   * @returns {Promise<void>}
   */
  rehydrateTreeData: async () => {
    const { specId } = get();
    if (specId == null) return;

    const match = findClassForSpec(specId);
    // The persisted spec no longer exists in the data (e.g. a game patch or a
    // data regen removed it). Don't strand the user on saved-but-unloadable
    // builds — clear back to a clean slate.
    if (!match) {
      set({ ...EMPTY, loadGen: get().loadGen + 1 });
      return;
    }

    await loadTreeData(set, get, match.cls.name, match.spec.name, specId, {
      preserveInteractive: true,
    });

    // If the load failed, treeData is null. Because findClassForSpec matched
    // above, the spec still exists in the data — this is a TRANSIENT failure
    // (offline, or a stale chunk 404 right after a deploy replaced the hashed
    // chunk this tab expects), not a permanently-unresolvable spec (that is the
    // !match branch above, which correctly clears). Resetting to EMPTY here would
    // overwrite the persisted buildStrings in localStorage and lose the user's
    // entered builds for good. Instead keep them with parallel null parsed slots
    // — the same recoverable state an in-session failed import leaves — and let
    // loadTreeData's error surface, so a later reload with connectivity retries
    // the load. With no restored builds there is nothing to preserve;
    // loadTreeData already reset to EMPTY on that (startedWithNoBuilds) path.
    if (!get().treeData) {
      const { buildStrings } = get();
      if (buildStrings.length > 0) {
        set({
          parsedBuilds: buildStrings.map(() => null),
          loadGen: get().loadGen + 1,
        });
      }
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

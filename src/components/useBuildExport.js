import { useState, useRef, useEffect, useCallback } from "react";

export function useBuildExport({
  currentBuildString,
  invalidNodeIdsSize,
  hasUserSelection,
  addBuild,
  replaceBuild,
  editingIndex,
  finishAddingBuild,
}) {
  const [exportState, setExportState] = useState("idle");
  const [copyState, setCopyState] = useState("idle");
  // Holds the pending "reset after the status flashes" timer so it can be
  // cleared if the component unmounts first (avoids a state update / store
  // mutation after teardown).
  const resetTimerRef = useRef(null);
  const copyTimerRef = useRef(null);

  useEffect(
    () => () => {
      if (resetTimerRef.current != null) clearTimeout(resetTimerRef.current);
      if (copyTimerRef.current != null) clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const handleCopyString = useCallback(async () => {
    if (
      copyState !== "idle" ||
      !currentBuildString ||
      invalidNodeIdsSize > 0 ||
      !hasUserSelection
    )
      return;
    try {
      await navigator.clipboard.writeText(currentBuildString);
      setCopyState("done");
      copyTimerRef.current = setTimeout(() => {
        copyTimerRef.current = null;
        setCopyState("idle");
      }, 2000);
    } catch {
      setCopyState("error");
      copyTimerRef.current = setTimeout(() => {
        copyTimerRef.current = null;
        setCopyState("idle");
      }, 2000);
    }
  }, [copyState, currentBuildString, invalidNodeIdsSize, hasUserSelection]);

  const handleExport = useCallback(async () => {
    if (
      exportState !== "idle" ||
      !currentBuildString ||
      invalidNodeIdsSize > 0 ||
      !hasUserSelection
    )
      return;
    setExportState("copying");
    try {
      let ok;
      if (editingIndex != null) {
        ok = await replaceBuild(editingIndex, currentBuildString);
      } else {
        await navigator.clipboard.writeText(currentBuildString);
        ok = await addBuild(currentBuildString);
      }
      // addBuild/replaceBuild set a store error and resolve falsy on rejection
      // (e.g. an identical build already in a slot); don't flash success or close
      // the editor in that case — surface it as a failure so the user can adjust.
      if (!ok) throw new Error("build was rejected");
      setExportState("done");
      // Delay hiding the interactive tree so "Copied & added!" is briefly visible.
      resetTimerRef.current = setTimeout(() => {
        resetTimerRef.current = null;
        setExportState("idle");
        finishAddingBuild();
      }, 2000);
    } catch {
      // Keep the interactive build open on failure so the user can retry; just
      // clear the transient "Failed" status after a moment.
      setExportState("error");
      resetTimerRef.current = setTimeout(() => {
        resetTimerRef.current = null;
        setExportState("idle");
      }, 2000);
    }
  }, [
    exportState,
    currentBuildString,
    invalidNodeIdsSize,
    hasUserSelection,
    addBuild,
    replaceBuild,
    editingIndex,
    finishAddingBuild,
  ]);

  return {
    exportState,
    copyState,
    handleCopyString,
    handleExport,
  };
}

import { useState, useRef, useEffect, useCallback } from "react";
import { createServerShare } from "../lib/shareLink";
import { generateSimcProfileset } from "../lib/simcProfile";

/**
 * Fallback to manually select and copy text when the Clipboard API is unavailable.
 */
function fallbackCopyTextToClipboard(text) {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  
  // Avoid scrolling to bottom
  textArea.style.top = "0";
  textArea.style.left = "0";
  textArea.style.position = "fixed";

  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();

  let successful = false;
  try {
    successful = document.execCommand('copy');
  } catch {
    // ignore
  }

  document.body.removeChild(textArea);
  return successful;
}

async function copyToClipboard(text) {
  if (!navigator.clipboard) {
    const success = fallbackCopyTextToClipboard(text);
    if (!success) throw new Error("Clipboard copy failed");
    return;
  }
  await navigator.clipboard.writeText(text);
}

export function useShareActions({
  classId,
  specId,
  buildStrings,
  buildNames,
  classDisplayName,
  specDisplayName,
  treeData,
  parsedBuilds,
  layoutHash,
}) {
  const [copyState, setCopyState] = useState("idle"); // 'idle' | 'copying' | 'copied' | 'error'
  const [simcState, setSimcState] = useState("idle"); // 'idle' | 'copied' | 'error'
  
  // Reset timers, cleared on unmount so they can't fire setState on a removed
  // share-controls component (e.g. clearing all builds within the 2s window).
  const copyTimer = useRef(null);
  const simcTimer = useRef(null);
  
  useEffect(
    () => () => {
      clearTimeout(copyTimer.current);
      clearTimeout(simcTimer.current);
    },
    [],
  );

  const handleCopyLink = useCallback(async () => {
    if (copyState !== "idle") return;
    setCopyState("copying");
    try {
      const labels = buildNames.some(Boolean) ? buildNames : undefined;
      const { id } = await createServerShare({
        classId,
        specId,
        builds: buildStrings,
        labels,
        className: classDisplayName,
        specName: specDisplayName,
        layoutHash,
      });
      // /s/<id> is the server-rendered share page (link previews); it redirects
      // humans to the SPA, which also opens a bare #<id> hash via the route
      // resolver. (Ids are content-addressed now, so links from before that
      // migration — old 6-char ids — no longer resolve.)
      const url = `${window.location.origin}/s/${id}`;
      await copyToClipboard(url);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    } finally {
      copyTimer.current = setTimeout(() => setCopyState("idle"), 2000);
    }
  }, [
    copyState,
    classId,
    specId,
    buildStrings,
    buildNames,
    classDisplayName,
    specDisplayName,
    layoutHash,
  ]);

  const handleCopySimc = useCallback(async () => {
    if (simcState !== "idle") return;
    setSimcState("copying");
    try {
      const profileset = generateSimcProfileset(
        buildStrings,
        buildNames,
        classDisplayName,
        specDisplayName,
        treeData,
        parsedBuilds,
      );
      await copyToClipboard(profileset);
      setSimcState("copied");
    } catch {
      setSimcState("error");
    } finally {
      simcTimer.current = setTimeout(() => setSimcState("idle"), 2000);
    }
  }, [
    simcState,
    buildStrings,
    buildNames,
    classDisplayName,
    specDisplayName,
    treeData,
    parsedBuilds,
  ]);

  return { copyState, simcState, handleCopyLink, handleCopySimc };
}

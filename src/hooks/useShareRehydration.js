import { useState, useEffect, useCallback, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useBuildsStore } from "../store/buildsStore";
import { resolveRoute } from "../lib/route";

export function useShareRehydration() {
  const {
    addBuild,
    clearAllBuilds,
    rehydrateTreeData,
    setBuildNames,
    preloadSpec,
    setSharedLayoutHash,
  } = useBuildsStore(
    useShallow((s) => ({
      addBuild: s.addBuild,
      clearAllBuilds: s.clearAllBuilds,
      rehydrateTreeData: s.rehydrateTreeData,
      setBuildNames: s.setBuildNames,
      preloadSpec: s.preloadSpec,
      setSharedLayoutHash: s.setSharedLayoutHash,
    })),
  );
  const [shareError, setShareError] = useState(null);
  const hasRehydrated = useRef(false);

  useEffect(() => {
    if (hasRehydrated.current) return;
    hasRehydrated.current = true;

    const applyAlignedNames = (builds, names) => {
      if (!names?.some(Boolean)) return;
      const nameByBuild = new Map(builds.map((b, i) => [b, names[i] ?? ""]));
      const landed = useBuildsStore.getState().buildStrings;
      const aligned = landed.map((b) => nameByBuild.get(b) ?? "");
      if (aligned.some(Boolean)) setBuildNames(aligned);
    };

    const route = resolveRoute();

    if (route.kind === "local") {
      rehydrateTreeData();
      return;
    }

    if (route.kind === "spec-page") {
      if (useBuildsStore.getState().specId == null) preloadSpec(route.specId);
      else rehydrateTreeData();
      return;
    }

    clearAllBuilds();

    (async () => {
      try {
        const apiBase = import.meta.env.BASE_URL + "api/share.php";
        const res = await fetch(
          `${apiBase}?id=${encodeURIComponent(route.id)}`,
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setShareError(body.error ?? "Shared link not found or has expired.");
          return;
        }
        const data = await res.json();
        if (!Array.isArray(data.builds) || data.builds.length === 0) {
          setShareError("Invalid share data.");
          return;
        }
        if (data.layoutHash) setSharedLayoutHash(data.layoutHash);
        for (const buildString of data.builds) {
          await addBuild(buildString);
        }
        applyAlignedNames(
          data.builds,
          Array.isArray(data.labels) ? data.labels : [],
        );
        history.replaceState(null, "", window.location.pathname);
      } catch {
        setShareError(
          "Failed to load shared builds. Check your connection and try again.",
        );
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const dismissShareError = useCallback(() => setShareError(null), []);
  return { shareError, dismissShareError };
}

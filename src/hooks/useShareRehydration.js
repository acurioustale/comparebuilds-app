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
        // Drop duplicate build strings, keeping the first occurrence's label.
        // The store rejects identical strings, but the share API doesn't dedupe,
        // so a crafted or legacy share could carry repeats. Loading them verbatim
        // would leave the duplicate permanently rejected (feeding the loop guarded
        // against below) and — because a Map keyed by build string keeps the last
        // value — mislabel the surviving slot with the duplicate's label.
        const rawLabels = Array.isArray(data.labels) ? data.labels : [];
        const builds = [];
        const labels = [];
        const seen = new Set();
        data.builds.forEach((b, i) => {
          if (seen.has(b)) return;
          seen.add(b);
          builds.push(b);
          labels.push(rawLabels[i]);
        });
        for (const buildString of builds) {
          await addBuild(buildString);
        }
        applyAlignedNames(builds, labels);
        // Strip the share id from the URL once at least one build has rendered.
        // addBuild fails *deterministically* — a duplicate, spec mismatch, corrupt
        // header, or over-cap slot never succeeds on retry — so keying the strip
        // off "every build committed" would loop forever: each reload re-fetches
        // the same share and re-fails, never stripping the hash. A transient
        // tree-data load failure instead leaves every slot unparsed, so keep the
        // hash only then, letting a reload retry the load.
        if (useBuildsStore.getState().parsedBuilds.some(Boolean)) {
          history.replaceState(null, "", window.location.pathname);
        }
      } catch {
        setShareError(
          "Failed to load shared builds. Check your connection and try again.",
        );
      }
    })();
  }, [
    addBuild,
    clearAllBuilds,
    rehydrateTreeData,
    setBuildNames,
    preloadSpec,
    setSharedLayoutHash,
  ]);

  const dismissShareError = useCallback(() => setShareError(null), []);
  return { shareError, dismissShareError };
}

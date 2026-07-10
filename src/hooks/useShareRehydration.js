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
      // A prerendered spec landing page must show the spec its URL names. Only
      // restore the persisted session instead when there's real work to keep —
      // imported builds, or an in-progress interactive selection already on that
      // same spec. When the persisted interactive spec differs from the URL (and
      // there are no imported builds to preserve), the URL wins, otherwise a
      // returning visitor's stale spec would shadow the landing page they opened.
      const { buildStrings, specId } = useBuildsStore.getState();
      if (buildStrings.length === 0 && specId !== route.specId) {
        preloadSpec(route.specId);
      } else {
        rehydrateTreeData();
      }
      return;
    }

    // Share route. The persisted local session is NOT cleared yet: the clear
    // happens only after the share payload has been fetched and validated, so
    // an expired/pruned link or a network failure can't destroy the previous
    // session (persist would overwrite localStorage the moment the store is
    // emptied). Until then the persisted state simply keeps rendering.
    //
    // Restores the persisted session's derived state (tree data, parsed
    // builds) after a failed share load, exactly like the plain-local route —
    // without it the session would sit in the store unrendered, since the
    // share route skips the mount-time rehydrateTreeData call.
    const restoreLocalSession = () => rehydrateTreeData();

    (async () => {
      try {
        const apiBase = import.meta.env.BASE_URL + "api/share.php";
        // Liveness beacon: an uncached ping that resets the share's retention
        // clock on every open. The data fetch below is served `immutable`, so a
        // warm-cache reopen never reaches the server — this separate `no-store`
        // request does, without defeating that cache. Fire-and-forget: retention
        // is best-effort and must never block or fail the rehydration.
        fetch(`${apiBase}?id=${encodeURIComponent(route.id)}&touch=1`, {
          cache: "no-store",
          keepalive: true,
        }).catch(() => {});
        const res = await fetch(
          `${apiBase}?id=${encodeURIComponent(route.id)}`,
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setShareError(body.error ?? "Shared link not found or has expired.");
          restoreLocalSession();
          return;
        }
        const data = await res.json();
        if (!Array.isArray(data.builds) || data.builds.length === 0) {
          setShareError("Invalid share data.");
          restoreLocalSession();
          return;
        }
        // The payload is valid — only now is replacing the previous session
        // justified. clearAllBuilds resets sharedLayoutHash too, so the hash
        // must be stamped after it.
        clearAllBuilds();
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
        let landed = 0;
        for (const buildString of builds) {
          if (await addBuild(buildString)) landed++;
        }
        applyAlignedNames(builds, labels);
        // Warn when the link carried more builds than we could load (a spec
        // mismatch, an over-cap slot, or a corrupt string among otherwise-valid
        // builds). The hash is stripped just below, so the dropped builds are
        // gone for good — surfacing fewer builds than the link encoded without a
        // word would be silent data loss. Only meaningful once something landed;
        // a total failure is handled by the retain-the-hash path below.
        if (landed > 0 && landed < builds.length) {
          const dropped = builds.length - landed;
          setShareError(
            `${dropped} of ${builds.length} builds in this link couldn't be ` +
              `loaded and were left out (they may not match the others' spec).`,
          );
        }
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
        // Before the clear this restores the intact persisted session; after
        // it (an addBuild rejection) the store is already empty and the
        // restore no-ops on the null specId — safe either way.
        restoreLocalSession();
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

import { useState, useEffect, useCallback } from "react";
import { entriesForSpec, loadTopBuilds } from "../lib/topBuilds";

/**
 * Availability of Raidbots top-sim reference builds for a spec.
 *
 * The table is fetched lazily on the first spec that asks for it and then held
 * for the session — it is one small committed file covering every spec, so
 * re-importing per spec change would buy nothing.
 *
 * The load runs when a spec is selected rather than when the button is clicked,
 * so the button can be hidden for the specs with no data instead of offering a
 * click that leads nowhere. The sample is DPS-sim data, so that is a real
 * fraction of specs (healers and tanks), not a rare edge case.
 *
 * @param {number|null} specId
 * @returns {{count: number, generatedAt: string|null}}
 */
export function useTopBuilds(specId) {
  const [table, setTable] = useState(null);

  useEffect(() => {
    if (specId == null || table) return;
    // A spec switch (or an unmount) while the import is in flight must not set
    // state afterwards — the cleanup flips this before the promise resolves.
    let cancelled = false;
    loadTopBuilds()
      .then((t) => {
        if (!cancelled) setTable(t);
      })
      .catch((err) => {
        // A failed optional import must not break the build manager: the
        // feature simply stays hidden, the paste flow is untouched.
        console.error(`Failed to load the top-sims table: ${err.message}`, err);
      });
    return () => {
      cancelled = true;
    };
  }, [specId, table]);

  return {
    count: entriesForSpec(table, specId).length,
    generatedAt: table?.generatedAt ?? null,
  };
}

/**
 * Wraps the store's addTopBuilds with the busy flag the button needs. The adds
 * are awaited (each triggers a parse, the first a class-data import), so
 * without this the control would look inert for the whole run.
 *
 * @param {() => Promise<number>} addTopBuilds
 * @returns {{busy: boolean, run: () => Promise<void>}}
 */
export function useAddTopBuilds(addTopBuilds) {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async () => {
    setBusy(true);
    try {
      await addTopBuilds();
    } finally {
      setBusy(false);
    }
  }, [addTopBuilds]);
  return { busy, run };
}

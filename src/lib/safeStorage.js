/**
 * Safe storage abstraction for Zustand persistence.
 *
 * Throw (rather than return undefined) when Web Storage is unavailable so
 * createJSONStorage disables persistence cleanly instead of building a
 * wrapper around an undefined store. This keeps the Node test environment,
 * where `localStorage` is not a real Storage, from crashing on writes.
 *
 * When localStorage is unavailable (Vitest, strict webviews, or Safari private
 * mode), provide an in-memory fallback storage implementation so persistence
 * degrades gracefully without dropping writes or throwing errors during active interaction.
 */
// Tombstone marker stored in the in-memory mirror to record "this key was
// removed" when the real store's removeItem() threw and may still hold a stale
// value. Persisted values are always strings, so a Symbol can never collide with
// a real value.
const REMOVED = Symbol("removed");

export function getSafeStorage() {
  const memStorage = new Map();
  const fallbackStorage = {
    getItem: (name) => memStorage.get(name) ?? null,
    setItem: (name, value) => memStorage.set(name, value),
    removeItem: (name) => memStorage.delete(name),
  };

  const getLocalStorage = () => {
    try {
      if (typeof localStorage !== "undefined" && localStorage) {
        return localStorage;
      }
    } catch {
      // Catch ReferenceError or access errors (like Node's experimental localStorage)
    }
    return null;
  };

  const ls = getLocalStorage();
  if (!ls) {
    return fallbackStorage;
  }

  const testKey = "__comparebuilds_test__";
  try {
    ls.setItem(testKey, "test");
    ls.removeItem(testKey);
  } catch {
    return fallbackStorage;
  }
  return {
    getItem: (name) => {
      // The mirror shadows the real store: it holds a value the real store
      // rejected (a fresh write kept in memory) or a REMOVED tombstone (a
      // removal the real store rejected). Either way the mirror wins, so a
      // stale value the real store still holds can't leak through.
      if (memStorage.has(name)) {
        const cached = memStorage.get(name);
        return cached === REMOVED ? null : cached;
      }
      return ls.getItem(name);
    },
    setItem: (name, value) => {
      try {
        ls.setItem(name, value);
        memStorage.delete(name);
      } catch {
        // Silently fallback if it errors later during tests or usage
        memStorage.set(name, value);
      }
    },
    removeItem: (name) => {
      try {
        ls.removeItem(name);
        memStorage.delete(name);
      } catch {
        // The real store rejected the removal and may still hold a stale value
        // (e.g. an older value left behind when a prior setItem hit quota and
        // the fresh write went to the mirror). Record a tombstone instead of
        // clearing the mirror, so getItem reports the key as gone rather than
        // resurrecting the stale real-store value.
        memStorage.set(name, REMOVED);
      }
    },
  };
}

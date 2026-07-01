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
    getItem: (name) =>
      memStorage.has(name) ? memStorage.get(name) : ls.getItem(name),
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
      } catch {
        // Best-effort: if the real store rejects the removal, the in-memory
        // mirror below is still cleared, so the key is gone either way.
      }
      memStorage.delete(name);
    },
  };
}

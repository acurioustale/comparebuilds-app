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

  if (typeof localStorage === "undefined" || !localStorage) {
    return fallbackStorage;
  }
  const testKey = "__comparebuilds_test__";
  try {
    localStorage.setItem(testKey, "test");
    localStorage.removeItem(testKey);
  } catch {
    return fallbackStorage;
  }
  return {
    getItem: (name) =>
      memStorage.has(name) ? memStorage.get(name) : localStorage.getItem(name),
    setItem: (name, value) => {
      try {
        localStorage.setItem(name, value);
        memStorage.delete(name);
      } catch (err) {
        console.error(
          `[zustand persist middleware] Failed to save state to localStorage: ${err.message}. Falling back to in-memory storage.`,
          err,
        );
        memStorage.set(name, value);
      }
    },
    removeItem: (name) => {
      localStorage.removeItem(name);
      memStorage.delete(name);
    },
  };
}

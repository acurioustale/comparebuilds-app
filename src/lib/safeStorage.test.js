import { afterEach, describe, expect, it, vi } from "vitest";

import { getSafeStorage } from "./safeStorage";

// A minimal in-memory Storage stand-in whose setItem/removeItem can be made to
// throw on demand, so we can drive getSafeStorage's fallback and tombstone paths
// without a real browser localStorage.
function makeFakeLocalStorage() {
  const store = new Map();
  const ctrl = { throwOnSet: false, throwOnRemove: false, throwOnGet: false };
  const ls = {
    getItem: (k) => {
      if (ctrl.throwOnGet) throw new DOMException("SecurityError");
      return store.has(k) ? store.get(k) : null;
    },
    setItem: (k, v) => {
      if (ctrl.throwOnSet) throw new DOMException("QuotaExceededError");
      store.set(k, String(v));
    },
    removeItem: (k) => {
      if (ctrl.throwOnRemove) throw new DOMException("SecurityError");
      store.delete(k);
    },
  };
  return { ls, ctrl, store };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getSafeStorage", () => {
  it("falls back to in-memory storage when localStorage is absent", () => {
    vi.stubGlobal("localStorage", undefined);
    const s = getSafeStorage();
    s.setItem("k", "v");
    expect(s.getItem("k")).toBe("v");
    s.removeItem("k");
    expect(s.getItem("k")).toBe(null);
  });

  it("falls back when the localStorage write probe throws", () => {
    const { ls, ctrl } = makeFakeLocalStorage();
    ctrl.throwOnSet = true; // the construction-time probe fails
    vi.stubGlobal("localStorage", ls);
    const s = getSafeStorage();
    s.setItem("k", "v");
    expect(s.getItem("k")).toBe("v"); // served from the in-memory fallback
  });

  it("reads and writes through to localStorage in the normal case", () => {
    const { ls, store } = makeFakeLocalStorage();
    vi.stubGlobal("localStorage", ls);
    const s = getSafeStorage();
    s.setItem("k", "v");
    expect(store.get("k")).toBe("v"); // written through
    expect(s.getItem("k")).toBe("v");
    s.removeItem("k");
    expect(store.has("k")).toBe(false);
    expect(s.getItem("k")).toBe(null);
  });

  it("returns null instead of throwing when getItem access is revoked mid-session", () => {
    // Regression: setItem/removeItem caught storage exceptions and degraded to
    // the mirror, but getItem called through unguarded — the one path that
    // could throw out of a module whose contract is to never throw. Simulates
    // access revoked AFTER the successful startup probe (browser settings
    // change, strict-webview teardown).
    const { ls, ctrl, store } = makeFakeLocalStorage();
    vi.stubGlobal("localStorage", ls);
    const s = getSafeStorage();
    store.set("k", "v"); // present in the real store
    ctrl.throwOnGet = true; // …but reads now throw
    expect(() => s.getItem("k")).not.toThrow();
    expect(s.getItem("k")).toBe(null);
    // A mirror-held value still wins without touching the throwing store.
    ctrl.throwOnSet = true;
    s.setItem("m", "mirrored");
    expect(s.getItem("m")).toBe("mirrored");
  });

  it("keeps a fresh write in the mirror when setItem hits quota mid-session", () => {
    const { ls, ctrl, store } = makeFakeLocalStorage();
    vi.stubGlobal("localStorage", ls);
    const s = getSafeStorage();
    s.setItem("k", "old"); // succeeds → written through, mirror cleared
    ctrl.throwOnSet = true;
    s.setItem("k", "new"); // quota → kept in mirror only
    expect(store.get("k")).toBe("old"); // real store still holds the stale value
    expect(s.getItem("k")).toBe("new"); // mirror shadows it
  });

  it("does not resurrect a stale value when removeItem throws (tombstone)", () => {
    const { ls, ctrl, store } = makeFakeLocalStorage();
    vi.stubGlobal("localStorage", ls);
    const s = getSafeStorage();
    s.setItem("k", "old"); // written through to the real store
    ctrl.throwOnSet = true;
    s.setItem("k", "new"); // quota → fresh value kept only in the mirror
    ctrl.throwOnRemove = true;
    s.removeItem("k"); // real removal rejected; must not expose the stale "old"
    expect(store.get("k")).toBe("old"); // real store unchanged
    expect(s.getItem("k")).toBe(null); // tombstone reports the key as gone
  });

  it("clears a tombstone when the key is written again", () => {
    const { ls, ctrl } = makeFakeLocalStorage();
    vi.stubGlobal("localStorage", ls);
    const s = getSafeStorage();
    ctrl.throwOnRemove = true;
    s.removeItem("k"); // tombstone recorded
    expect(s.getItem("k")).toBe(null);
    ctrl.throwOnRemove = false;
    s.setItem("k", "v"); // real write succeeds → mirror (and tombstone) cleared
    expect(s.getItem("k")).toBe("v");
  });
});

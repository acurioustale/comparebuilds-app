// @vitest-environment jsdom
/**
 * Cross-tab and back/forward-cache sync for the theme hook. A theme change made
 * in one tab reaches the others through a `storage` event, and a bfcache-restored
 * page re-reads the stored mode on `pageshow` (it missed the storage events fired
 * while it was frozen). Both must update `mode` without writing back to storage,
 * so there is no cross-tab loop. Parity with acurioustale's theme-toggle handlers.
 */

import { describe, test, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTheme } from "./useTheme.jsx";
import { THEME_STORAGE_KEY } from "../lib/theme.js";

// The shared setup installs a no-op localStorage stub (it only silences a Node
// warning). The bfcache path re-reads real storage, so give this suite a working
// in-memory store; setItem/getItem must actually round-trip for that test to mean
// anything.
beforeEach(() => {
  const store = new Map();
  window.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
});

function fireStorage({ key, newValue }) {
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
  });
}

function firePageshow(persisted) {
  act(() => {
    const evt = new Event("pageshow");
    Object.defineProperty(evt, "persisted", { value: persisted });
    window.dispatchEvent(evt);
  });
}

describe("useTheme cross-tab sync", () => {
  test("mirrors a light choice made in another tab", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe("auto");

    fireStorage({ key: THEME_STORAGE_KEY, newValue: "light" });
    expect(result.current.mode).toBe("light");
  });

  test("treats a whole-store clear (key === null) as a return to auto", () => {
    const { result } = renderHook(() => useTheme());
    fireStorage({ key: THEME_STORAGE_KEY, newValue: "dark" });
    expect(result.current.mode).toBe("dark");

    // localStorage.clear() dispatches a storage event with key and newValue null.
    fireStorage({ key: null, newValue: null });
    expect(result.current.mode).toBe("auto");
  });

  test("ignores storage events for unrelated keys", () => {
    const { result } = renderHook(() => useTheme());
    fireStorage({ key: THEME_STORAGE_KEY, newValue: "dark" });
    expect(result.current.mode).toBe("dark");

    fireStorage({ key: "some-other-key", newValue: "light" });
    expect(result.current.mode).toBe("dark");
  });

  test("does not persist when mirroring (no cross-tab write-back loop)", () => {
    renderHook(() => useTheme());
    fireStorage({ key: THEME_STORAGE_KEY, newValue: "light" });
    // The originating tab already persisted; this tab only reflects the value.
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });
});

describe("useTheme bfcache restore", () => {
  test("re-reads the stored mode on a persisted pageshow", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe("auto");

    // Another tab changed the theme while this page was frozen in the bfcache;
    // this page never saw the storage event, so its state is stale until restore.
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    firePageshow(true);
    expect(result.current.mode).toBe("dark");
  });

  test("ignores a normal (non-persisted) pageshow", () => {
    const { result } = renderHook(() => useTheme());
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    firePageshow(false);
    expect(result.current.mode).toBe("auto");
  });
});

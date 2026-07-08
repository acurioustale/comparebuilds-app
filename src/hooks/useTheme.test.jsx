// @vitest-environment jsdom
/**
 * Cross-tab and back/forward-cache sync for the theme hook. A theme change made
 * in one tab reaches the others through a `storage` event, and a bfcache-restored
 * page re-reads the stored mode on `pageshow` (it missed the storage events fired
 * while it was frozen). Both must update `mode` without writing back to storage,
 * so there is no cross-tab loop. Parity with acurioustale's theme-toggle handlers.
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
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

  test("re-reads the OS preference on a persisted pageshow", () => {
    // The matchMedia change listener is silent while the page is frozen, so an
    // OS light/dark switch during the freeze is invisible until restore. Model a
    // mutable OS preference: dark at mount, flipped to light while frozen.
    let osLight = false;
    const original = window.matchMedia;
    window.matchMedia = (query) => ({
      matches: query.includes("light") ? osLight : !osLight,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    });
    try {
      const { result } = renderHook(() => useTheme());
      // auto + OS dark → dark theme.
      expect(result.current.theme).toBe("dark");

      // OS switches to light while the page is bfcache-frozen (no change event).
      osLight = true;
      firePageshow(true);
      expect(result.current.theme).toBe("light");
    } finally {
      window.matchMedia = original;
    }
  });
});

describe("useTheme theme-color meta cache", () => {
  const addMeta = (media) => {
    const m = document.createElement("meta");
    m.setAttribute("name", "theme-color");
    m.setAttribute("media", media);
    document.head.append(m);
    return m;
  };

  test("does not permanently cache an empty lookup when the metas arrive late", async () => {
    // Fresh module so metaCache starts undefined, independent of other suites.
    vi.resetModules();
    document.head
      .querySelectorAll('meta[name="theme-color"]')
      .forEach((m) => m.remove());
    const { themeColorMetas } = await import("./useTheme.jsx");

    // Metas absent on first lookup — must NOT poison the cache.
    expect(themeColorMetas()).toEqual({ light: null, dark: null });

    // They appear later (e.g. injected after the hook first ran); the next
    // lookup must find them rather than returning the cached nulls.
    const light = addMeta("(prefers-color-scheme: light)");
    const dark = addMeta("(prefers-color-scheme: dark)");
    const res = themeColorMetas();
    expect(res.light).toBe(light);
    expect(res.dark).toBe(dark);
  });

  test("re-queries when cached metas become detached (HMR remount)", async () => {
    vi.resetModules();
    document.head
      .querySelectorAll('meta[name="theme-color"]')
      .forEach((m) => m.remove());
    const { themeColorMetas } = await import("./useTheme.jsx");

    const light1 = addMeta("(prefers-color-scheme: light)");
    const dark1 = addMeta("(prefers-color-scheme: dark)");
    expect(themeColorMetas().light).toBe(light1);

    // The old tags are torn out and replaced (a remount into a fresh document).
    light1.remove();
    dark1.remove();
    const light2 = addMeta("(prefers-color-scheme: light)");
    const dark2 = addMeta("(prefers-color-scheme: dark)");
    const res = themeColorMetas();
    expect(res.light).toBe(light2);
    expect(res.dark).toBe(dark2);
  });
});

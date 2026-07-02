import { useState, useEffect, useCallback } from "react";
import {
  THEME_STORAGE_KEY,
  resolveMode,
  resolveTheme,
  nextMode,
} from "../lib/theme";

function prefersLight() {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-color-scheme: light)").matches
  );
}

function readStoredMode() {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredMode(mode) {
  try {
    if (mode === "auto") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
}

// Cache the two <meta name="theme-color"> tags on first lookup. They must be
// selected by their authored `prefers-color-scheme` media at load: applyTheme
// mutates that media on every pass, so re-querying by media after the first
// flip would fail. The pre-paint inline script only touches data-theme, so the
// tags still carry their light/dark media when this first runs.
let metaCache;
function themeColorMetas() {
  if (metaCache) return metaCache;
  metaCache = {
    light: document.querySelector('meta[name="theme-color"][media*="light"]'),
    dark: document.querySelector('meta[name="theme-color"][media*="dark"]'),
  };
  return metaCache;
}

// Force the browser-chrome tint to follow the toggle by flipping each meta's
// `media` — never rewriting its authored `content`. In "auto" the metas track
// the OS via their prefers-color-scheme queries; an explicit mode makes exactly
// one meta win ("all") and the other lose ("not all"). Mirrors acurioustale's
// setScheme so the chrome follows the forced theme under any OS preference.
function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === "auto") delete root.dataset.theme;
  else root.dataset.theme = mode;

  const { light, dark } = themeColorMetas();
  if (!light || !dark) return;
  if (mode === "auto") {
    light.setAttribute("media", "(prefers-color-scheme: light)");
    dark.setAttribute("media", "(prefers-color-scheme: dark)");
  } else {
    light.setAttribute("media", mode === "light" ? "all" : "not all");
    dark.setAttribute("media", mode === "dark" ? "all" : "not all");
  }
}

export function useTheme() {
  const [mode, setMode] = useState(() => resolveMode(readStoredMode()));
  const [systemLight, setSystemLight] = useState(prefersLight);

  const theme = resolveTheme(mode, systemLight);

  useEffect(() => {
    applyTheme(mode);
  }, [mode]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (e) => setSystemLight(e.matches);
    // Safari <=13's MediaQueryList predates addEventListener; fall back to the
    // deprecated addListener there so an unguarded call can't throw and abort
    // the effect. Parity with acurioustale's toggle, which guards the same API.
    if (mq.addEventListener) {
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);

  // Mirror theme changes made in other tabs, and re-read on back/forward-cache
  // restore. A `storage` event fires in every *other* tab when one writes the
  // key (e.key is null when the whole store is cleared); reflecting it via
  // setMode keeps open tabs in sync. The originating tab already persisted the
  // value, so we only mirror it here — no write back, no cross-tab loop. A
  // bfcache-restored page never saw the storage events fired while it was frozen,
  // so its mode can lag another tab's change (and the next toggle would then
  // cycle from a stale mode); pageshow with e.persisted re-reads and re-applies.
  // Parity with acurioustale's storage + pageshow handlers.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== null && e.key !== THEME_STORAGE_KEY) return;
      setMode(resolveMode(e.newValue));
    };
    const onPageshow = (e) => {
      if (e.persisted) setMode(resolveMode(readStoredMode()));
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("pageshow", onPageshow);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pageshow", onPageshow);
    };
  }, []);

  const cycleTheme = useCallback(
    () =>
      setMode((current) => {
        const next = nextMode(current, systemLight);
        writeStoredMode(next);
        return next;
      }),
    [systemLight],
  );

  return { mode, theme, next: nextMode(mode, systemLight), cycleTheme };
}

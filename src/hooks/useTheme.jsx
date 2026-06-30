import { useState, useEffect, useCallback } from "react";
import {
  THEME_STORAGE_KEY,
  THEME_COLORS,
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

function applyTheme(mode, resolvedTheme) {
  const root = document.documentElement;
  if (mode === "auto") delete root.dataset.theme;
  else root.dataset.theme = mode;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLORS[resolvedTheme]);
}

export function useTheme() {
  const [mode, setMode] = useState(() => resolveMode(readStoredMode()));
  const [systemLight, setSystemLight] = useState(prefersLight);

  const theme = resolveTheme(mode, systemLight);

  useEffect(() => {
    applyTheme(mode, theme);
  }, [mode, theme]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (e) => setSystemLight(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
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

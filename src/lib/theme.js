/**
 * Pure theme-resolution helpers. No DOM access lives here (the localStorage /
 * matchMedia / documentElement glue is in the useTheme hook in App.jsx and the
 * inline anti-flash script in index.html), so this stays Node-testable under the
 * lib/ coverage gate.
 *
 * ARCHITECTURAL PARITY: This core three-way theme cycle logic ("auto", "light",
 * "dark") is shared in parity with acurioustale (js/theme.js). Both projects
 * derive cycle order dynamically from the OS preference to eliminate dead first
 * clicks, and keep DOM access strictly decoupled from the pure state transitions.
 *
 * The model: a three-way mode — "auto" (follow the OS), "light", "dark" —
 * persisted under THEME_STORAGE_KEY. "auto" is the default when nothing valid is
 * stored. The *resolved* theme (what the DOM actually paints) is always light or
 * dark; "auto" resolves through the OS `prefers-color-scheme`.
 */

// Resolved colours the DOM can actually be in.
export const THEMES = ["dark", "light"];

// The toggle's three cycle states.
export const MODES = ["auto", "light", "dark"];

export const THEME_STORAGE_KEY = "comparebuilds-theme";

// Drives the <meta name="theme-color"> chrome colour per resolved theme.
export const THEME_COLORS = { dark: "#0d0d14", light: "#f3e7cb" };

// A persisted value is honoured only if it's one of the three modes; anything
// else (null, stale, tampered) means "no stored mode".
/**
 * @param {string|null} value Persisted mode string
 * @returns {string|null} Normalised mode string or null
 */
export function normalizeStoredMode(value) {
  return value === "light" || value === "dark" || value === "auto"
    ? value
    : null;
}

// The persisted mode, defaulting to "auto" when nothing valid is stored.
/**
 * @param {string|null} stored Persisted mode string
 * @returns {string} Active mode string
 */
export function resolveMode(stored) {
  return normalizeStoredMode(stored) ?? "auto";
}

// The active theme: explicit light/dark modes win; "auto" follows the OS.
/**
 * @param {string} mode Resolved mode string ('auto'|'light'|'dark')
 * @param {boolean} prefersLight User OS prefers light mode
 * @returns {string} Active theme string ('light'|'dark')
 */
export function resolveTheme(mode, prefersLight) {
  if (mode === "light" || mode === "dark") return mode;
  return prefersLight ? "light" : "dark";
}

// "auto" renders identically to the OS preference, so exactly one step of the
// three-way cycle is always colour-neutral. Deriving the order from the OS — so
// the explicit theme that MATCHES the OS is visited LAST — parks that neutral
// step on the wrap back to "auto" (where "return to automatic looks the same"
// reads as intentional). Every other click then visibly flips light/dark, with
// no dead first click. Recomputed from live `prefersLight` each call, so an OS
// change between clicks is handled for free.
/**
 * @param {string} current Current mode string
 * @param {boolean} prefersLight User OS prefers light mode
 * @returns {string} Next mode string in cycle
 */
export function nextMode(current, prefersLight) {
  const order = prefersLight
    ? ["auto", "dark", "light"]
    : ["auto", "light", "dark"];
  return order[(order.indexOf(current) + 1) % order.length];
}

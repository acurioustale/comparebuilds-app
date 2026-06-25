/**
 * Pure theme-resolution helpers. No DOM access lives here (the localStorage /
 * matchMedia / documentElement glue is in the useTheme hook in App.jsx and the
 * inline anti-flash script in index.html), so this stays Node-testable under the
 * lib/ coverage gate.
 *
 * The model: dark is the default. A user's explicit toggle is a "sticky"
 * override persisted under THEME_STORAGE_KEY; with no override we follow the OS
 * `prefers-color-scheme`. Light/dark only — there is no separate "system" state.
 */

export const THEMES = ['dark', 'light']

export const THEME_STORAGE_KEY = 'comparebuilds-theme'

// Drives the <meta name="theme-color"> chrome colour per theme.
export const THEME_COLORS = { dark: '#0d0d14', light: '#f3e7cb' }

// A persisted value is only honoured if it's one of the explicit themes the user
// could have chosen; anything else (null, stale, tampered) means "no override".
export function normalizeStoredTheme(value) {
  return value === 'light' || value === 'dark' ? value : null
}

// The active theme: an explicit stored override wins, otherwise the OS preference.
export function resolveTheme(stored, prefersLight) {
  return normalizeStoredTheme(stored) ?? (prefersLight ? 'light' : 'dark')
}

export function nextTheme(current) {
  return current === 'dark' ? 'light' : 'dark'
}

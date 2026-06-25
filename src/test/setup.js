// Vitest global setup.
//
// Extends `expect` with @testing-library/jest-dom matchers (toBeInTheDocument,
// toBeDisabled, toHaveTextContent, …). This only augments the matcher set — it
// does not require a DOM at import time, so it is harmless for the Node-environment
// suites and active for the jsdom component suites.
import '@testing-library/jest-dom/vitest'

// jsdom has no matchMedia. The theme hook queries prefers-color-scheme, so stub
// a minimal (non-matching → OS-dark) implementation for the component suites.
// Guarded so the Node-environment suites, which have no window, are untouched.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })
}

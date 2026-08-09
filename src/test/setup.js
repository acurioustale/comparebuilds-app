// Vitest global setup.
//
// Extends `expect` with @testing-library/jest-dom matchers (toBeInTheDocument,
// toBeDisabled, toHaveTextContent, …). This only augments the matcher set — it
// does not require a DOM at import time, so it is harmless for the Node-environment
// suites and active for the jsdom component suites.
import "@testing-library/jest-dom/vitest";
// Testing Library's findBy*/waitFor carry their OWN deadline, separate from
// Vitest's testTimeout — and it defaults to 1s. Raising testTimeout to 30s in
// #421 therefore only half-covered the starvation it diagnosed: it stopped a
// whole test being cut off, but the 62 async waits across the component suites
// still had a second each. A worker starved for longer than that fails with an
// "Unable to find an element" assertion in a run that finishes in seconds, which
// reads as a real regression rather than a busy machine — the same misdiagnosis
// #421 set out to prevent, just at the other layer.
//
// 10s clears the worst stall that commit measured (5.4s of wall time for
// microseconds of work) and stays well under testTimeout, so a genuinely stuck
// wait still fails here first — with the element query and DOM dump that make it
// debuggable — rather than as a bare test timeout.
//
// Imported behind the DOM check, and from @testing-library/react (a direct
// dependency) rather than its hoisted @testing-library/dom peer. A static import
// would pull React and react-dom into the ~35 Node-environment suites that never
// render anything, which measured a consistent 0.7s of extra setup across the
// run for no benefit.
if (typeof window !== "undefined") {
  const { configure } = await import("@testing-library/react");
  configure({ asyncUtilTimeout: 10_000 });
}

// jsdom has no matchMedia. The theme hook queries prefers-color-scheme, so stub
// a minimal (non-matching → OS-dark) implementation for the component suites.
// Guarded so the Node-environment suites, which have no window, are untouched.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}

// Node emits an ExperimentalWarning when localStorage is referenced without a file.
// Stub a minimal implementation globally to silence the warning during Node suites.
if (typeof globalThis !== "undefined" && !globalThis.localStorage) {
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  };
}

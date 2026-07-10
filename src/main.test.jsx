// @vitest-environment jsdom
/**
 * Boot smoke test for the module entry point.
 *
 * Regression: the retired-service-worker cache cleanup called caches.keys()
 * with no guard, unlike the serviceWorker line above it. In restricted-storage
 * browsers (historic Firefox private windows, strict webviews) touching
 * `caches` throws synchronously — at module top level that aborted main.jsx
 * before createRoot ran, leaving a blank page — and the returned promises
 * rejected unhandled on every load.
 */

import { test, expect } from "vitest";

test("boots even when touching the Cache API throws", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  // jsdom has no Cache API; install a booby-trapped one. `"caches" in window`
  // passes (the property exists) but any actual access throws, mimicking the
  // restricted-storage SecurityError.
  Object.defineProperty(window, "caches", {
    configurable: true,
    get() {
      throw new Error("SecurityError: cache storage is not allowed");
    },
  });
  try {
    await expect(import("./main.jsx")).resolves.toBeDefined();
  } finally {
    delete window.caches;
  }
});

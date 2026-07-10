import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";

// One-time cleanup of the retired icon-cache service worker. Earlier versions
// registered a worker that cached wow.zamimg.com icons; icons are now served
// first-party from /talent-icons, so the worker is gone. Returning visitors are still
// controlled by the old worker (which also cached opaque, sometimes-blocked
// responses for days) until it's unregistered, so do that and purge its caches.
// The worker only intercepted zamimg, never the app shell, so this code always
// runs on the next visit. Safe to remove once the install base has turned over.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then((regs) => regs.forEach((reg) => reg.unregister()))
    .catch(() => {});
}
// Guarded like the serviceWorker block above, and more: the `in` check probes
// the prototype without invoking the getter, but in restricted-storage modes
// (historic Firefox private windows, strict webviews) merely *touching*
// `caches` can throw synchronously — at module top level that would abort the
// bundle before createRoot ever runs (blank page) — and keys()/delete() can
// reject, surfacing as unhandled rejections on every load.
try {
  if ("caches" in window) {
    caches
      .keys()
      .then((keys) => keys.forEach((key) => caches.delete(key).catch(() => {})))
      .catch(() => {});
  }
} catch {
  // Cache API unavailable — nothing to clean up.
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

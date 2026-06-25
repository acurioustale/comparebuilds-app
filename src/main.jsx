import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";

// One-time cleanup of the retired icon-cache service worker. Earlier versions
// registered a worker that cached wow.zamimg.com icons; icons are now served
// first-party from /icons, so the worker is gone. Returning visitors are still
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
if ("caches" in window) {
  caches.keys().then((keys) => keys.forEach((key) => caches.delete(key)));
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

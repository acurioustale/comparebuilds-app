/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Baseline Content-Security-Policy delivered as a <meta> tag in the built HTML.
// It is the locally-testable (vite preview) and defence-in-depth twin of the
// production superset in public/.htaccess: identical on every directive a <meta>
// CSP can express, so the header only adds frame-ancestors and
// upgrade-insecure-requests on top. tools/check-csp.mjs asserts the two stay in
// lock-step against the built dist/, so a directive loosened or a script hash
// drifted in only one place fails the build.
//
// IMPORTANT: this is injected at BUILD time only (apply: "build"). The Vite dev
// server injects its own inline HMR/React-refresh scripts that a strict
// script-src would block, so a <meta> CSP must never reach dev — hence it lives
// here, not in the source index.html.
//
// The 'sha256-…' allowlists the inline anti-flash theme script in index.html. It
// is the SAME hash carried by the .htaccess header; if you edit that inline
// script, recompute it (check-csp prints the expected token) and update it in
// BOTH this string and public/.htaccess, or the two policies drift and the guard
// fails.
const META_CSP = [
  "default-src 'self'",
  "script-src 'self' 'sha256-xh7M2t3oCHA26cHM02ChDRcJob4ZPTl0JQfjj9EbBJo='",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

function cspMetaPlugin() {
  return {
    name: "inject-csp-meta",
    apply: "build",
    transformIndexHtml(html) {
      // Insert the meta as the first thing in <head> via a literal string splice
      // (not the tag-descriptor API) so the policy's single quotes reach the
      // markup verbatim, never HTML-entity-escaped. prerenderSpecs.js clones the
      // built index.html for the spec pages, so they inherit it unchanged.
      const meta = `<meta http-equiv="Content-Security-Policy" content="${META_CSP}" />`;
      return html.replace(/<head>/i, `<head>\n    ${meta}`);
    },
  };
}

export default defineConfig({
  base: "/",
  plugins: [cspMetaPlugin(), react(), tailwindcss()],
  test: {
    // Pure-logic suites run in Node; component suites opt into jsdom per-file via
    // a `// @vitest-environment jsdom` pragma at the top of the file.
    environment: "node",
    globals: true,
    setupFiles: ["./src/test/setup.js"],
    include: ["src/**/*.test.{js,jsx}", "scripts/**/*.test.js"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // Gated scope: the logic layers (exercised without a DOM). Logic lives in
      // lib/ by convention and components stay thin, so this is where the quality
      // bar matters. `all: true` reports untested files at their true numbers.
      all: true,
      include: ["src/lib/**/*.js", "src/store/**/*.js"],
      exclude: ["**/*.test.js", "**/wireLayout.snapshot.json"],
      // Coverage ratchet: CI runs `npm run coverage`, which fails below these
      // floors. Set a few points under current (stmts 93 / branch 89 / func 92 /
      // lines 95) to absorb normal churn. Raise them as coverage climbs; never lower.
      thresholds: {
        statements: 90,
        branches: 86,
        functions: 89,
        lines: 92,
        // treeLogic is the correctness core — the prereq/gate/co-located cascade
        // shared by the interactive, diff, and heatmap views. Hold it at a hard
        // 100% (per-file glob threshold) so any uncovered branch fails CI, not
        // just drags the aggregate down. Keep its tests exhaustive.
        "**/src/lib/treeLogic.js": {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});

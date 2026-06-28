/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss()],
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

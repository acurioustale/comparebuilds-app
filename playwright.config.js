import { defineConfig, devices } from "@playwright/test";

// Browser smoke tests for the layout- and theming-dependent behaviour the jsdom
// component suites can't reach: jsdom has no layout engine, no computed
// color-scheme, and can't resolve the light-dark() palette or run the lazy
// class-data import + render path end to end. Specs live in e2e/ with a
// .spec.js suffix so Vitest (which only collects src/**/*.test.{js,jsx} and
// scripts/**/*.test.js — see vite.config.js) never tries to run them, and this
// config's testDir keeps Playwright off the Vitest suites in turn.
//
// The server is the Vite dev server on its usual port (matches the "dev" entry
// in .claude/launch.json). Playwright starts it on CI and reuses a running one
// locally, so `npm run dev` in another terminal makes the specs start instantly.
const PORT = 5173;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

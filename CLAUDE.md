# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`comparebuilds` is a World of Warcraft talent-build comparison tool (deployed at comparebuilds.app). It's a React 19 + Vite + Tailwind v4 single-page app. Users paste in the game's native talent loadout strings; the app decodes them and renders trees side-by-side (diff for 2 builds, adoption heatmap for 3+), plus an interactive calculator for building from scratch. Sharing is backed by a small PHP + MariaDB short-link API. There is no runtime backend for the app itself — it's static files plus that one share endpoint.

## Commands

```bash
npm run dev          # Vite dev server (PHP API is NOT available locally — share links 404 locally)
npm run build        # produce static site in dist/
npm run lint         # ESLint (flat config); CI runs this before the tests
npm test             # run all Vitest suites once
npm run test:watch   # watch mode
npm run coverage     # run with coverage; FAILS below the thresholds in vite.config.js
npx vitest run src/lib/buildString.test.js   # run a single test file
npx vitest run -t "round-trip"               # run tests matching a name
node scripts/ingestTalentData.js             # regenerate src/data/ from the upstream source
UPDATE_SNAPSHOTS=1 npm test                  # deliberately rewrite wireLayout snapshots (see below)
```

CI (`.github/workflows`) runs `npm run lint`, then `npm run coverage` (enforcing thresholds), then `npm run build` on every push/PR. Coverage is gated only over `src/lib/**` and `src/store/**` — keep logic there, keep components thin. The thresholds in `vite.config.js` are a ratchet: raise as coverage climbs, never lower.

## Architecture

**Data is the contract.** The app reads ONLY the normalised JSON in `src/data/*.json` (one file per class, plus `classes.json` as the index). It never talks to any external source at runtime. How that JSON is produced — the Icy Veins ingest script, a hand edit, or a different source — is an implementation detail behind the schema enforced by `src/lib/validateClassData.js`. When swapping or repopulating data, the only requirement is that the output matches that schema; the validator and round-trip tests will tell you when it's right.

**The three layers:**

- `src/lib/` — pure logic, no DOM, unit-tested in Node. This is where correctness lives:
  - `buildString.js` — decode/encode the game's binary talent loadout string (LSB-first base64 bit-packing; format fully documented in the file header). `collectClassNodes()` builds the class-wide, ascending-sorted node list that the parser walks — node bit-positions depend on this exact ordering. The wire format is fixed by the game and version-locked (`SERIALIZATION_VERSION = 2`); parsers reject other versions loudly.
  - `treeLogic.js` — prerequisite + gate-threshold cascade (`computeInvalidNodeIds`, `hasUpperPrereq`, `gatedPoints`). Shared by the interactive and import views so they can't drift.
  - `spendRules.js` — interactive calculator's "can I spend a point here" rules (section budgets, hero-subtree exclusivity, gates, prereqs).
  - `diff.js` / `heatmap.js` — pure comparison + adoption-counting logic, extracted from their components for testing.
  - `validateClassData.js`, `wireLayout.js`, `sanitizeDescription.js` — schema validation, wire-layout fingerprinting, HTML sanitisation at ingest.
- `src/store/buildsStore.js` — single Zustand store; the app's state machine. Holds the raw build strings, their parsed results (kept parallel — `null` = not-yet-parsed or failed), the loaded `treeData`/`classNodes`, and interactive selections. Class JSON is dynamically imported per-class (lazy Vite chunks via `import.meta.glob`). A module-level `loadGen` counter cancels stale async loads on reset/spec-switch. `MAX_BUILDS`/`MAX_BUILD_LEN` here are mirrored server-side in `api/share.php` — keep them in sync.
- `src/components/` — thin React renderers. `App.jsx`/`MainView` picks the view by valid-build count: 0 → `InteractiveTalentTree`, 1 → `TalentTree`, 2 → `SideBySideDiff`, 3+ → `HeatmapTree`. `treeLayout.js` holds shared geometry constants so `TalentTree` and `HeatmapTree` can't diverge. `FitToWidth.jsx` scales each tree/comparison panel to the viewport width via a uniform CSS transform (scale, don't reflow). Icons come from Wowhead's CDN via `lib/zamimg.js`.

Routing is hash-based (a 6-char share id in the URL hash); there are no rewrite rules — `index.html` serves every route.

## The wire-layout snapshot — read before editing `src/data/`

`src/lib/wireLayout.snapshot.json` fingerprints each class's build-string bit layout. After any data change, run `npm test`:

- A **schema** failure (`dataIntegrity.test.js` / `validateClassData`) means the file is structurally wrong — fix it.
- A **wire-layout snapshot** failure means your change shifted build-string bit positions, so **every existing build string and share link for that class now parses differently**. Only if that's intentional (e.g. a new game patch added nodes) regenerate it deliberately with `UPDATE_SNAPSHOTS=1 npm test`. `scripts/ingestTalentData.js` refreshes the snapshot automatically and aborts without updating it if any class fails validation.

The data-correctness tests most worth understanding: `buildString.test.js` (per-class encode→decode round-trips), `buildFixtures.test.js` (decodes real in-game-exported strings to confirm node IDs/ordering/budgets), `dataIntegrity.test.js` (schema + snapshot), `treeLogic.test.js` (prereq/gate cascade).

## Vitest environment convention

Tests default to the `node` environment. Component suites that need a DOM opt in per-file with a `// @vitest-environment jsdom` pragma at the top of the file (`src/test/setup.js` is the shared setup).

## Deployment

`npm run build` → upload the **contents** of `dist/` to the web root, and `api/share.php` into an `api/` subfolder there. `config.php` (MariaDB credentials + `SHARE_IP_SALT`) lives one level **above** the web root so it stays private if PHP processing fails. `share.php` runs `CREATE TABLE IF NOT EXISTS` itself and prunes rows older than 90 days. Full steps, server layout, and the share-link API contract/limits are in `README.md`. The API is hardened for public exposure (per-IP rate limit, body cap, strict validation, same-origin only, prepared statements) — preserve those properties when touching `share.php`.

## Conventions

Commits follow Conventional Commits (`type(scope): imperative`, lowercase, ≤72-char header, no attribution trailers, hyphens not dashes). Scopes seen in history: `ui`, `api`, `security`, `interactive`, `deps`. Versioning is SemVer.

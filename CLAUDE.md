# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`comparebuilds` is a World of Warcraft talent-build comparison tool (deployed at comparebuilds.app). It's a React 19 + Vite + Tailwind v4 single-page app. Users paste in the game's native talent loadout strings; the app decodes them and renders trees side-by-side (diff for 2 builds, adoption heatmap for 3+), plus an interactive calculator for building from scratch. Sharing is backed by a small PHP + MariaDB short-link API. There is no runtime backend for the app itself — it's static files plus that one share endpoint.

## Commands

```bash
npm run dev          # Vite dev server (PHP API is NOT available locally — share links 404 locally)
npm run build        # produce static site in dist/
npm run lint         # ESLint (flat config)
npm run format       # Prettier write across the repo (format:check verifies; used by CI)
npm test             # run all Vitest suites once
npm run test:watch   # watch mode
npm run coverage     # run with coverage; FAILS below the thresholds in vite.config.js
./validate.sh        # run the FULL gate locally: shell, php, lint, format, css/md/svg, tests, build
npx vitest run src/lib/buildString.test.js   # run a single test file
npx vitest run -t "round-trip"               # run tests matching a name
node scripts/ingestBlizzard.js               # verify the Blizzard source (Game Data API + client DB2) against the snapshot (writes nothing); --promote to write src/data/ (the live primary); --no-descriptions / --no-icons to skip the soft fetches. Needs API credentials — see .env.example
node scripts/ingestIcyVeins.js               # regenerate src/data/ from the Icy Veins source (fallback)
node scripts/ingestWowhead.js                # verify/--promote the Wowhead source (fallback); --no-descriptions to skip the tooltip fetch
node scripts/compareSources.js               # diff a source vs committed data (hard = build-string fields, soft = presentational); --source=blizzard|wowhead (default wowhead)
node scripts/fetchIcons.js                   # download referenced icons into public/talent-icons/ (incremental; commit the result)
UPDATE_SNAPSHOTS=1 npm test                  # deliberately rewrite wireLayout snapshots (see below)
```

CI is the `validate` job in `.github/workflows/deploy.yml`, run on every push/PR: ESLint, Prettier, stylelint (CSS), markdownlint, svgo (SVG), `php -l` + php-cs-fixer + PHPUnit (the share API), shfmt + shellcheck (shell scripts), actionlint (workflows), then `npm run coverage` (enforcing thresholds) and `npm run build`. The `deploy` job in the same workflow `needs: validate`, so a red gate never ships (deploy is skipped on PRs). `./validate.sh` mirrors the gate locally — the brew-installed CLIs (shellcheck, shfmt, php-cs-fixer, phpunit, actionlint) are skipped with a notice when absent, while CI pins them; the npm tools always run. Link checking (lychee) lives in a separate `links.yml` workflow, deliberately kept out of the gate so a dead link never blocks a release. Coverage is gated only over `src/lib/**` and `src/store/**` — keep logic there, keep components thin. The thresholds in `vite.config.js` are a ratchet: raise as coverage climbs, never lower.

## Architecture

**Data is the contract.** The app reads ONLY the normalised JSON in `src/data/*.json` (one file per class, plus `classes.json` as the index). It never talks to any external source at runtime. How that JSON is produced — the Icy Veins ingest script, a hand edit, or a different source — is an implementation detail behind the schema enforced by `src/lib/validateClassData.js`. When swapping or repopulating data, the only requirement is that the output matches that schema; the validator and round-trip tests will tell you when it's right.

**Multiple sources, one contract.** There are three ingests, all mapping their upstream to the schema and handing off to the shared, source-agnostic pipeline `scripts/lib/ingestCore.js` (validate → write `src/data/` → regenerate the snapshot):

- `scripts/ingestBlizzard.js` — the **primary**, snapshot-owning source. It reads Blizzard's official Game Data API (the authoritative upstream the others copy from) for tree structure, and the client's DB2 tables (via wago.tools, `scripts/lib/blizzardDb2.js`) for the one thing the web API flattens — the spec **apex** capstone's true rank chain (distinct per-level spells, ranks, unlock levels) — plus the authoritative per-node points gate (`spentRequired`). It needs Battle.net API credentials (build-time only; see `.env.example` and `scripts/lib/blizzardApi.js`).
- `scripts/ingestIcyVeins.js` and `scripts/ingestWowhead.js` — prepared **fallbacks**, used if Blizzard is behind or down. `--promote` switches the live writer.

Cross-source agreement is provable because every source uses Blizzard's own trait-node IDs, so the wire-layout snapshot (see below) is the oracle: a source whose per-class fingerprints match the committed snapshot is build-string-compatible. `scripts/compareSources.js` checks this — it normalises a chosen source (`--source=blizzard|wowhead`) in memory and diffs it against the committed data, separating **hard** divergences (wire layout, ranks, choice arity, gates, prereqs — must agree) from **soft** ones (positions, names, descriptions, per-spec membership — sources legitimately differ; e.g. one shows a node another treats as an unused placeholder). With Blizzard as primary, `--source=blizzard` is the deepest cross-check (DB2 is the closest thing to the game itself) and `--source=wowhead` proves the fallback still agrees. It runs in the non-gating `sources.yml` workflow (network-dependent, kept out of the validate gate like `links.yml`). To switch the live source, run `node scripts/ingest<Source>.js --promote` (writes `src/data/`; add `--update-snapshot` only to deliberately redefine the build-string oracle). All ingests are byte-faithful for everything that affects build strings and the gate. Descriptions are _current_ game text (Blizzard renders them inline; the scrapers fetch per-spell), so they legitimately differ between sources — descriptions are soft, so that difference never affects sharing or correctness. NB: Blizzard's tree layout is the game's own grid, so promoting it re-lays-out every tree (positions are soft); the renderer normalises per panel, and `display_col` is doubled to the step-2 spacing the renderer expects so choice nodes don't overlap.

**The three layers:**

- `src/lib/` — pure logic, no DOM, unit-tested in Node. This is where correctness lives:
  - `buildString.js` — decode/encode the game's binary talent loadout string (LSB-first base64 bit-packing; format fully documented in the file header). `collectClassNodes()` builds the class-wide, ascending-sorted node list that the parser walks — node bit-positions depend on this exact ordering. The wire format is fixed by the game and version-locked (`SERIALIZATION_VERSION = 2`); parsers reject other versions loudly.
  - `treeLogic.js` — prerequisite + gate-threshold cascade (`computeInvalidNodeIds`, `hasUpperPrereq`, `gatedPoints`). Shared by the interactive and import views so they can't drift.
  - `spendRules.js` — interactive calculator's "can I spend a point here" rules (section budgets, hero-subtree exclusivity, gates, prereqs).
  - `diff.js` / `heatmap.js` — pure comparison + adoption-counting logic, extracted from their components for testing. They also classify what counts as a "difference" for the comparison views' changes-only filter (`diff.js` per-node highlights; `heatmap.js` `isContested`/`isDivergent`, where a heatmap "change" is split adoption or a choice node whose picks diverge).
  - `validateClassData.js`, `wireLayout.js`, `sanitizeDescription.js` — schema validation, wire-layout fingerprinting, HTML sanitisation at ingest.
- `src/store/buildsStore.js` — single Zustand store; the app's state machine. Holds the raw build strings, their parsed results (kept parallel — `null` = not-yet-parsed or failed), the loaded `treeData`/`classNodes`, and interactive selections. Class JSON is dynamically imported per-class (lazy Vite chunks via `import.meta.glob`). A module-level `loadGen` counter cancels stale async loads on reset/spec-switch. `MAX_BUILDS`/`MAX_BUILD_LEN` here are mirrored server-side in `api/share.php` — keep them in sync.
- `src/components/` — thin React renderers. `App.jsx`/`MainView` picks the view by valid-build count: 0 → `InteractiveTalentTree`, 1 → `TalentTree`, 2 → `SideBySideDiff`, 3+ → `HeatmapTree`. `treeLayout.js` holds shared geometry constants so `TalentTree` and `HeatmapTree` can't diverge. `FitToWidth.jsx` scales each tree/comparison panel to the viewport width via a uniform CSS transform (scale, don't reflow). The search box and the comparison views' "changes only" toggle (which dims the nodes the builds agree on) both live in `MainView` and drive every tree node through one `useNodeEmphasis` hook (`SearchContext.js`), so the diff and heatmap renderers can't dim differently. Icons are served first-party from `/talent-icons` (URL built by `lib/iconUrl.js`); they're downloaded from Wowhead's CDN by `scripts/fetchIcons.js` and committed under `public/talent-icons/`, because hotlinking the third-party CDN got the images blocked by content blockers and browser tracking protection. (The path is `/talent-icons`, not `/icons`, because Apache reserves `/icons` for mod_autoindex's directory-listing graphics — that server-level alias shadows a web-root `icons/` folder.)

Routing is hash-based (a 6-char share id in the URL hash); the SPA's own routes are all served by `index.html`. The one server-side rewrite (`public/.htaccess`) is unrelated to SPA routing: it maps the pretty share URLs `/s/<id>` to `api/share.php` for link-unfurl previews.

## The wire-layout snapshot — read before editing `src/data/`

`src/lib/wireLayout.snapshot.json` fingerprints each class's build-string bit layout. After any data change, run `npm test`:

- A **schema** failure (`dataIntegrity.test.js` / `validateClassData`) means the file is structurally wrong — fix it.
- A **wire-layout snapshot** failure means your change shifted build-string bit positions, so **every existing build string and share link for that class now parses differently**. Only if that's intentional (e.g. a new game patch added nodes) regenerate it deliberately with `UPDATE_SNAPSHOTS=1 npm test`. `scripts/ingestIcyVeins.js` refreshes the snapshot automatically and aborts without updating it if any class fails validation.

The data-correctness tests most worth understanding: `buildString.test.js` (per-class encode→decode round-trips), `buildFixtures.test.js` (decodes real in-game-exported strings to confirm node IDs/ordering/budgets), `dataIntegrity.test.js` (schema + snapshot), `treeLogic.test.js` (prereq/gate cascade).

## Vitest environment convention

Tests default to the `node` environment. Component suites that need a DOM opt in per-file with a `// @vitest-environment jsdom` pragma at the top of the file (`src/test/setup.js` is the shared setup).

## Deployment

Pushes to `main` auto-deploy via GitHub Actions: the `deploy` job in `.github/workflows/deploy.yml` runs only after the `validate` gate job in the same workflow passes (`needs: validate`), so a red push never ships. The manual/local path is `npm run build` → upload the **contents** of `dist/` to the web root, and `api/share.php` into an `api/` subfolder there. `config.php` (MariaDB credentials + `SHARE_IP_SALT`) lives one level **above** the web root so it stays private if PHP processing fails. `share.php` runs `CREATE TABLE IF NOT EXISTS` itself and prunes rows older than 90 days. Full steps, server layout, and the share-link API contract/limits are in `README.md`. The API is hardened for public exposure (per-IP rate limit, body cap, strict validation, same-origin only, prepared statements) — preserve those properties when touching `share.php`. Its input validation lives in pure, PHPUnit-covered helpers (`validate_share_input` / `valid_share_id`, tests in `tests/`); the request dispatch is guarded behind `SHARE_API_NO_MAIN` so those helpers can be included and tested without a database. PHP is held to PSR-12 by php-cs-fixer.

## Conventions

Commits follow Conventional Commits (`type(scope): imperative`, lowercase, ≤72-char header, no attribution trailers, hyphens not dashes). Scopes seen in history: `ui`, `api`, `security`, `interactive`, `deps`. Versioning is SemVer.

Formatting and linting are tool-enforced (Prettier, shfmt, php-cs-fixer, stylelint, markdownlint, svgo, actionlint) — run `./validate.sh` before pushing to catch exactly what CI gates. Keep a large mechanical reformat in its own commit and list it in `.git-blame-ignore-revs` so `git blame` skips it.

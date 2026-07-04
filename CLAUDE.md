# CLAUDE.md

Guidance for Claude Code (claude.ai/code) in this repo.

## What this is

`comparebuilds` (comparebuilds.app): a WoW talent-build comparison tool. React 19 + Vite + Tailwind v4 SPA. Users paste the game's native talent loadout strings; app decodes them and renders trees side-by-side (diff for 2 builds, adoption heatmap for 3+), plus an interactive calculator. Sharing is backed by a small PHP + MariaDB short-link API. No runtime backend for the app itself — static files plus that one share endpoint.

## Commands

```bash
npm run dev          # Vite dev server (PHP API is NOT available locally — share links 404 locally)
npm run build        # produce static site in dist/ (also prerenders spec landing pages, sitemap, robots.txt)
npm run lint         # ESLint (flat config)
npm run format       # Prettier write across the repo (format:check verifies; used by CI)
npm test             # run all Vitest suites once
npm run test:watch   # watch mode
npm run coverage     # run with coverage; FAILS below the thresholds in vite.config.js
npm run check:csp    # verify inline script hashes match BOTH CSPs (built <meta> baseline + dist/.htaccess header) and the two policies agree (runs against built dist/)
npm run check:og     # verify public/og-image.png dimensions (1200×630); guards against OG image drift
./validate.sh        # run the FULL gate locally: shell, php, lint, format, css/md/svg, tests, build, CSP, OG, sitemap
npx vitest run src/lib/buildString.test.js   # run a single test file
npx vitest run -t "round-trip"               # run tests matching a name
node scripts/ingestBlizzard.js               # verify the data (Game Data API + client DB2) against the snapshot (writes nothing); --promote to write src/data/; --no-descriptions / --no-icons to skip the soft fetches. Needs API credentials — see .env.example
node scripts/compareSources.js               # re-derive from Blizzard live and diff vs committed data — the drift/freshness check (hard = build-string fields, soft = presentational)
node scripts/fetchIcons.js                   # download referenced icons (Blizzard render CDN) into public/talent-icons/ (incremental; commit the result)
UPDATE_SNAPSHOTS=1 npm test                  # deliberately rewrite wireLayout snapshots (see below)
```

CI is the `validate` job in `.github/workflows/deploy.yml`, on every push/PR: ESLint, Prettier, stylelint (CSS), markdownlint, svgo (SVG), `php -l` + php-cs-fixer + PHPUnit (share API + OG renderer), shfmt + shellcheck, actionlint, then `npm run coverage` (enforcing thresholds) and `npm run build`, then these guards:

- **CSP guard** (`npm run check:csp` → `tools/check-csp.mjs`). The CSP is declared twice: a `<meta>` baseline injected into the built HTML by `cspMetaPlugin` in `vite.config.js` (the `vite preview` twin — build-time only, so the dev server's inline HMR scripts aren't blocked) and the `dist/.htaccess` header superset (adds `frame-ancestors`/`upgrade-insecure-requests`, which a `<meta>` CSP can't express). The guard recomputes the sha256 of every inline `<script>` in built `dist/index.html` and fails if a token is missing from **either** policy (so the anti-flash theme script's hash can't drift from the allowlisting policies), and fails if the two policies disagree on any other directive (catching a loosening applied to only one).
- **OG image guard** (`npm run check:og` → `tools/check-og-image.mjs`): reads the PNG IHDR, fails if `public/og-image.png` isn't 1200×630.
- **sitemap check** (`xmllint --noout dist/sitemap.xml`): freshly built sitemap must be well-formed XML.
- **HTML validation** (Nu Html Checker over `dist/` — entry page, every prerendered spec landing page, SVG favicon; needs a JVM, so CI sets up Java 21 + downloads `vnu.jar`). Two `file://`-only infos are filtered (void-element trailing slash, Vite/Prettier house style; and the meta-CSP resolve failure, where `script-src 'self'` + inline-hash allowlist can't resolve without an origin). Generated Tailwind CSS is deliberately not checked (vnu rejects modern properties).

The `deploy` job `needs: validate`, so a red gate never ships (deploy skipped on PRs). After a successful deploy, `deploy.sh` runs `api/cron/ensure_schema.php` over SSH to apply pending schema migrations. `./validate.sh` mirrors the gate locally — brew-installed CLIs (shellcheck, shfmt, php-cs-fixer, phpunit, actionlint, xmllint, vnu) are skipped with a notice when absent (CI pins them); npm tools always run.

Non-gating workflows, kept out of the gate deliberately: link checking (lychee, `links.yml`) so a dead link never blocks a release; PHP static analysis (Semgrep, `semgrep.yml`) uploading SARIF to GitHub code scanning (Security tab) to cover `api/*.php` that CodeQL's default setup can't (no PHP support) — like CodeQL, never fails on findings, an alert is a triage signal not a blocked deploy.

Coverage is gated only over `src/lib/**` and `src/store/**` — keep logic there, keep components thin. Thresholds in `vite.config.js` are a ratchet: raise as coverage climbs, never lower. `treeLogic.js` has a per-file 100% threshold — the prereq/gate cascade is the correctness core.

## Architecture

**Data is the contract.** The app reads ONLY the normalised JSON in `src/data/*.json` (one file per class, plus `classes.json` as the index). It never talks to any external source at runtime. How that JSON is produced is an implementation detail behind the schema enforced by `src/lib/validateClassData.js`. When swapping or repopulating data, the only requirement is the output matches that schema; the validator and round-trip tests confirm it.

**One source: Blizzard.** `scripts/ingestBlizzard.js` is the sole ingest, mapping Blizzard's data to the schema and handing off to the shared pipeline `scripts/lib/ingestCore.js` (validate → write `src/data/` → regenerate the snapshot). It reads Blizzard's **Game Data API** for tree structure, and the client's **DB2** tables (via wago.tools, `scripts/lib/blizzardDb2.js`) for what the web API doesn't expose cleanly — the spec **apex** capstone's true rank chain (distinct per-level spells, ranks, unlock levels), the authoritative per-node points gate (`spentRequired`), and hero-subtree descriptions. Needs Battle.net API credentials (build-time only; see `.env.example` and `scripts/lib/blizzardApi.js`). `--promote` writes `src/data/`; add `--update-snapshot` only to deliberately redefine the build-string oracle. (History: Icy Veins and Wowhead were earlier sources, removed once Blizzard + DB2 replaced them. The pipeline stays source-agnostic.)

`scripts/compareSources.js` is the drift/freshness check: re-derives from Blizzard live and diffs against committed `src/data/`, separating **hard** divergences (wire layout, ranks, choice arity, gates, prereqs — must agree) from **soft** (positions, names, descriptions, per-spec membership). Runs in the non-gating `sources.yml` workflow (network + API secrets, kept out of the gate). A red run means committed data has drifted from a new game patch (or a bad hand-edit) — investigate, not a blocked release. NB: Blizzard's tree layout is the game's own grid, so the data uses it directly (positions soft); the renderer normalises per panel, and `display_col` is doubled to the step-2 spacing the renderer expects so choice nodes don't overlap.

**The three layers:**

- `src/lib/` — pure logic, no DOM, unit-tested in Node. Where correctness lives:
  - `buildString.js` — decode/encode the game's binary talent loadout string (LSB-first base64 bit-packing; format documented in the file header). `collectClassNodes()` builds the class-wide, ascending-sorted node list the parser walks — node bit-positions depend on this exact ordering. Wire format is fixed by the game and version-locked (`SERIALIZATION_VERSION = 2`); parsers reject other versions loudly. `bitStream.js` is the underlying bit reader/writer.
  - `treeLogic.js` — prerequisite + gate-threshold cascade (`computeInvalidNodeIds`, `hasUpperPrereq`, `gatedPoints`). Shared by interactive and import views so they can't drift.
  - `spendRules.js` — interactive calculator's "can I spend a point here" rules (section budgets, hero-subtree exclusivity, gates, prereqs).
  - `diff.js` / `heatmap.js` — pure comparison + adoption-counting logic, extracted from their components for testing. Also classify what counts as a "difference" for the changes-only filter (`diff.js` per-node highlights; `heatmap.js` `isContested`/`isDivergent`, where a heatmap "change" is split adoption or a choice node whose picks diverge).
  - `validateClassData.js`, `wireLayout.js`, `sanitizeDescription.js` — schema validation, wire-layout fingerprinting, HTML sanitisation at ingest.
  - `exportBuild.js` — generates a valid build string from an interactive selection (prunes inactive hero subtrees, injects hero gate selection).
  - `buildLabel.js` — default human-readable label for a build slot.
  - `simcProfile.js` — SimulationCraft profileset block from the active comparison slots.
  - `prereqChain.js` — hover-highlight helper: node ids directly relevant to a hovered node (itself, direct prerequisites, direct dependents).
  - `route.js` — entry-route resolution: from the URL, load a server share, a prerendered spec page, or restore from local storage.
  - `shareLink.js` — POSTs build data to the share API, returns the short-link ID.
  - `safeStorage.js` — safe storage abstraction for Zustand persistence where Web Storage is unavailable.
  - `talentSearch.js` — matcher for the search box: node ids whose name/description contains the query.
  - `theme.js` — pure three-way theme-cycle helpers (auto/light/dark), no DOM. Parity with acurioustale.
  - `iconUrl.js` — builds the first-party icon URL (`/talent-icons/…`).
- `src/store/` — single Zustand store; the app's state machine. `buildsStore.js` is the entry point, composed of slices (`slices/buildsSlice.js`, `slices/interactiveSlice.js`). Holds raw build strings, their parsed results (kept parallel — `null` = not-yet-parsed or failed), loaded `treeData`/`classNodes`, and interactive selections. Class JSON is dynamically imported per-class (lazy Vite chunks via `import.meta.glob` in `storeHelpers.js`). A module-level `loadGen` counter (`slices/loadTreeData.js`) cancels stale async loads on reset/spec-switch. `MAX_BUILDS`/`MAX_BUILD_LEN`/`MAX_BUILD_NAME_LEN` in `slices/constants.js` are mirrored server-side in `api/share.php` (`MAX_BUILDS`, `MAX_BUILD_LEN`, `MAX_LABEL_LEN`) — keep them in sync.
- `src/hooks/` — React hooks: share rehydration (`useShareRehydration.js`), share actions (`useShareActions.js`), theme (`useTheme.jsx`).
- `src/components/` — thin React renderers. `App.jsx`/`MainView` picks the view by valid-build count: 0 → `InteractiveTalentTree`, 1 → `TalentTree`, 2 → `SideBySideDiff`, 3+ → `HeatmapTree`. `treeLayout.js` holds shared geometry constants so `TalentTree` and `HeatmapTree` can't diverge. `FitToWidth.jsx` scales each panel to viewport width via a uniform CSS transform (scale, don't reflow). The search box (`TalentSearch.jsx`) and the "changes only" toggle (dims nodes builds agree on) are both wired in `MainView` and drive every node through one `useNodeEmphasis` hook (`SearchContext.js`), so diff and heatmap renderers can't dim differently. `SearchContext.js` exports three contexts: `SearchContext` (query match), `ChangesFilterContext` (changes-only toggle), `SpotlightContext` (a single node id dimming everything else — driven by `DiffSummaryTable` hover-to-spotlight). `TalentNode.jsx` is the shared node renderer for every tree view. `Tooltip.jsx` wraps Floating UI for themed hover/click tooltips. `DiffSummaryTable.jsx` renders a tabular summary of talent differences; hovering a row spotlights that node via `SpotlightContext`. `BuildManager.jsx`/`BuildManagerSlots.jsx` manage the build input slots. `useBuildExport.js` and `useTapGesture.js` are local hooks for the interactive tree's export UX and touch gestures. Icons are served first-party from `/talent-icons` (URL built by `lib/iconUrl.js`), downloaded from Blizzard's render CDN by `scripts/fetchIcons.js` and committed under `public/talent-icons/`, because hotlinking the CDN got images blocked by content blockers and tracking protection. (Path is `/talent-icons`, not `/icons`, because Apache reserves `/icons` for mod_autoindex's directory-listing graphics — that alias shadows a web-root `icons/` folder.)

Routing is hash-based (an 8–16 char content-addressed share id in the URL hash); the SPA's own routes are all served by `index.html`. The one server-side rewrite (`public/.htaccess`) is unrelated to SPA routing: it maps pretty share URLs `/s/<id>` to `api/share.php` for link-unfurl previews.

## The wire-layout snapshot — read before editing `src/data/`

`src/lib/wireLayout.snapshot.json` fingerprints each class's build-string bit layout. After any data change, run `npm test`:

- A **schema** failure (`dataIntegrity.test.js` / `validateClassData`) means the file is structurally wrong — fix it.
- A **wire-layout snapshot** failure means your change shifted build-string bit positions, so **every existing build string and share link for that class now parses differently**. Only if intentional (e.g. a new game patch added nodes) regenerate deliberately with `UPDATE_SNAPSHOTS=1 npm test`. `scripts/ingestBlizzard.js --promote --update-snapshot` regenerates the snapshot too — merging the promoted classes' fingerprints into the existing file — and aborts without updating it if any class fails validation; `--promote` alone writes `src/data/` but leaves the snapshot untouched.

Key data-correctness tests: `buildString.test.js` (per-class encode→decode round-trips), `buildFixtures.test.js` (decodes real in-game-exported strings to confirm node IDs/ordering/budgets), `dataIntegrity.test.js` (schema + snapshot), `treeLogic.test.js` (prereq/gate cascade). Cross-stack parity tests keep JS and PHP mirrors from drifting: `limitsParity.test.js` pins `MAX_BUILDS`/`MAX_BUILD_LEN`/`MAX_BUILD_NAME_LEN` against `api/share.php`; `shareIdParity.test.js` pins the share-id regex in `route.js` against `share.php` and `og.php`.

## Vitest environment convention

Tests default to the `node` environment. Component suites needing a DOM opt in per-file with a `// @vitest-environment jsdom` pragma at the top (`src/test/setup.js` is the shared setup).

## Deployment

Pushes to `main` auto-deploy via GitHub Actions: the `deploy` job runs only after the `validate` gate passes (`needs: validate`), so a red push never ships. `deploy.sh` stages `dist/` together with the PHP API (`api/share.php`, `api/og.php`, `api/lib/`, `api/fonts/`, `api/cron/`, `api/current_layouts.json`) into one tree and mirrors it with a single `rsync -avz --delete` to the web root; after a successful rsync it runs `api/cron/ensure_schema.php` over SSH to apply pending schema migrations **and** reconcile the layout-history table from `api/current_layouts.json` (build-generated manifest of currently-valid layout hashes — see retention note below).

The staged list MUST include every runtime dependency of the API — `api/lib/` holds `RateLimiter.php`, which `share.php` requires; `api/current_layouts.json` lets the prune job tell superseded layouts from current. Omitting either makes `rsync --delete` remove it server-side and either fatal every share/OG request or silently break supersession-gated pruning.

The deploy key is confined server-side by a forced-command rsync jail; reviewed source tracked at `ops/rsync-jail-comparebuilds.sh` (manually installed to `~/bin/` on the host — the server copy is authoritative). The jail allow-lists exactly the SSH commands `deploy.sh` issues (the rsync push and the `ensure_schema.php` migration), so a new `ssh` call in `deploy.sh` needs a matching jail entry and a reinstall, or the deploy fails with `rsync-jail: only rsync push allowed`. Manual/local path: `npm run build` → `./deploy.sh` (or `--dry-run` to preview).

`config.php` (MariaDB credentials, `SHARE_IP_SALT`, optional `REDIS_HOST`/`REDIS_PORT`, proxy trust flags) lives one level **above** the web root so it stays private if PHP processing fails.

Schema DDL — `CREATE TABLE IF NOT EXISTS` for every table plus additive `ADD COLUMN`/`ADD INDEX IF NOT EXISTS` retention migrations — lives in `ensure_share_schema` in `share.php`, but is invoked **only** by the deploy-time `api/cron/ensure_schema.php` migration (CLI-guarded, run over SSH); live `share.php` requests never issue DDL. `get_db_connection` keeps schema creation separate so endpoints don't pay a DDL round-trip or take metadata locks on the hot path.

Pruning is **supersession-gated**, not flat-age: a `GET` touches the row's `last_accessed` (debounced to one write/day; response cached `immutable`, so it only fires on a cold-cache open) and each share stamps its `layout_hash`; the daily cron `api/cron/prune_shares.php` deletes a share only once its layout is no longer current **and** the link has been unaccessed for 180 days **and** that layout was superseded ≥180 days ago (so the idle window is entirely post-supersession) — a live-layout or recently-opened link is never pruned; legacy rows with no `layout_hash` age out on the unaccessed clock alone. `ensure_schema.php` maintains the `comparebuilds_layout_history` table (which hash is live vs. when superseded) by reconciling against `api/current_layouts.json` on every deploy; an empty/missing manifest is a no-op so a broken build can never mass-supersede.

`og.php` renders the Open Graph preview image for shared links (needs PHP GD with FreeType; ships its own bold TTF in `api/fonts/`); it caches rendered images in `cache_og/` one level **above** the web root (beside `config.php`, resolved as `../../cache_og` from `api/`) so `rsync --delete` can't wipe the cache each deploy and `prune_shares.php` cleans the same directory `og.php` writes.

Full steps, server layout, and the share-link API contract/limits are in `README.md`. The API is hardened for public exposure (per-IP rate limit via database or optional Redis, fail-fast GET_LOCK timeout, strict CSP, body cap, strict validation, same-origin only, prepared statements, explicit proxy trust flags) — preserve those properties when touching `share.php`. Its input validation lives in pure, PHPUnit-covered helpers (`validate_share_input` / `valid_share_id`, tests in `tests/`); request dispatch is guarded behind `SHARE_API_NO_MAIN` so those helpers can be included and tested without a database. The PHP test suite (`tests/`) covers share validation, concurrency, OG rendering, and supersession-retention helpers (`OgRenderTest.php`, `ShareConcurrencyTest.php`, `ShareValidationTest.php`, `LayoutRetentionTest.php`). PHP is held to PSR-12 by php-cs-fixer.

## Conventions

Commits follow Conventional Commits (`type(scope): imperative`, lowercase, ≤72-char header, no attribution trailers, hyphens not dashes). Scopes seen in history: `ui`, `api`, `security`, `interactive`, `deps`. Versioning is SemVer.

Formatting and linting are tool-enforced (Prettier, shfmt, php-cs-fixer, stylelint, markdownlint, svgo, actionlint) — run `./validate.sh` before pushing to catch exactly what CI gates. Keep a large mechanical reformat in its own commit and list it in `.git-blame-ignore-revs` so `git blame` skips it.

## Memory

Facts not cheaply greppable and not covered above. (`GEMINI.md` symlinks to this file — one memory serves both agents.)

- **Toolchain is pinned in `.tool-versions`**: nodejs 22, php 8.4, plus shfmt/php-cs-fixer/phpunit/actionlint versions. CI reads it via `setup-node`'s `node-version-file`; match it when reproducing CI locally. `npm` (package-lock.json) — CI installs with `npm ci`.
- **Browser e2e: `npm run test:e2e`** (Playwright; tests in `e2e/`, config `playwright.config.js`). Smoke tests for the layout/theming behaviour jsdom can't reach — the `light-dark()` theme repaint and the lazy class-data import + tree-render pipeline. Non-gating (`e2e.yml`, path-filtered, `workflow_dispatch`), like `links.yml`/`sources.yml`/`semgrep.yml`; deploys gate on `validate` only, never on e2e.

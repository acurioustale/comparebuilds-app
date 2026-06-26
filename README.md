# comparebuilds

WoW talent build comparison tool — deployed at comparebuilds.app.

## Deployment

### Automated deploys

Pushing to `main` deploys automatically, but only after the gate passes. The
[`deploy` workflow](.github/workflows/deploy.yml) runs its `validate` job first
(the full quality gate — lint, formatting, the per-language linters, tests, and
the build) and only then its `deploy` job, which `needs: validate`; a push that
fails the gate never ships. It can also be triggered manually from the Actions
tab, with an optional dry-run — manual runs validate first too. The deploy job
builds the site and runs `deploy.sh`. `deploy.sh` stages the built `dist/` together with the PHP API
(`api/share.php`, `api/og.php`, `api/fonts/`) into one tree and mirrors it with a
single `rsync -avz --delete` to the web root:

```text
web4186@http2.core-networks.de:html/comparebuilds.app/
```

Staging the two sources into one tree is what makes `--delete` safe: `dist/` has
no `api/`, so deleting against `dist/` alone would wipe the live API folder.
`config.php` (below) lives one level above the web root and is never touched.

CI authenticates with a dedicated SSH deploy key, stored as the repository
secrets `DEPLOY_SSH_KEY` and `DEPLOY_KNOWN_HOSTS`. The key is harmless if leaked:
on the host it's pinned to a forced command
(`~web4186/bin/rsync-jail-comparebuilds.sh`, wired up in that account's
`authorized_keys`) that allows only an rsync _push_ into `html/comparebuilds.app/`
— no shell, no pull, and no path traversal outside that directory. This is why
the deploy target in `deploy.sh` must keep its trailing slash; the jail matches
on that exact prefix.

To deploy by hand instead (uses your own SSH access), run:

```bash
./deploy.sh            # live
./deploy.sh --dry-run  # preview what would change
```

### First-time server setup

The steps below prepare the host that the automated deploy relies on but does
not perform — the credentials file, database, and domain. Steps 1 and 2 also
document the build output and on-server file layout, which `deploy.sh` now
handles for you.

### 1. Build the frontend

```bash
npm run build
```

This produces a `dist/` folder containing the static site. It also prerenders a
crawlable landing page per class+spec (`dist/<class>/<spec>/index.html`, e.g.
`/death-knight/blood/`) with its own title/description/Open Graph tags and a
static summary, plus `sitemap.xml` and `robots.txt`. These are plain files inside
`dist/`, so they ship with the normal upload — no extra step. The live app still
uses hash routing; the spec pages exist so search engines and link unfurls have
real content, and opening one boots the calculator on that spec.

### 2. Upload files to the server

Upload the **contents** of `dist/` to the web root folder (the folder that comparebuilds.app points to). Upload `api/share.php`, `api/og.php`, and the `api/fonts/` folder into an `api/` subfolder inside that same web root.

`og.php` renders the Open Graph preview image for shared links and needs PHP's **GD** extension with FreeType (for text). It ships its own bold TTF in `api/fonts/`, so no system fonts are required; set `OG_FONT_PATH` in `config.php` only to override it. It emits whichever image format the host's GD supports (PNG → JPEG → GIF → WebP), so it works even on GD builds without PNG. Make sure the `api/fonts/` folder is uploaded alongside `og.php`. Pretty share URLs (`/s/<id>`) rely on `mod_rewrite` (configured in the shipped `.htaccess`).

Expected layout on the server:

```text
/home/username/
├── config.php          ← credentials file, above the web root
└── www/                ← web root (comparebuilds.app → this folder)
    ├── index.html
    ├── .htaccess        ← shipped from dist/ (mod_rewrite for /s/<id>, security headers)
    ├── assets/
    ├── talent-icons/    ← self-hosted talent icons (committed; see scripts/fetchIcons.js)
    └── api/
        ├── share.php
        ├── og.php
        └── fonts/
            └── DejaVuSans-Bold.ttf
```

### 3. Create config.php above the web root

Copy `api/config.php.example` to `/home/username/config.php` (one level above the web root) and fill in your MariaDB credentials:

```php
<?php
define('DB_HOST', 'localhost');
define('DB_NAME', 'your_database_name');
define('DB_USER', 'your_db_user');
define('DB_PASS', 'your_db_password');
```

This location keeps the credentials inaccessible to the public even if PHP processing were to fail.

### 4. Create the database table

`share.php` runs `CREATE TABLE IF NOT EXISTS` on every request, so the table is created automatically on first use. You can also create it manually via your MariaDB/MySQL client (phpMyAdmin, CLI, or your host's database tool):

```sql
CREATE TABLE IF NOT EXISTS comparebuilds_shares (
    id         CHAR(6)    NOT NULL PRIMARY KEY,
    data       MEDIUMTEXT NOT NULL,
    ip_hash    CHAR(64)   NULL,
    created_at TIMESTAMP  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_created (created_at),
    INDEX idx_ip_created (ip_hash, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

`ip_hash` stores a salted SHA-256 of the creator's IP, used only for per-IP rate
limiting (20 shares/hour by default).

### 5. Point the domain

In your hosting control panel, point the `comparebuilds.app` domain to the web root folder you uploaded to. The SPA itself uses hash-based routing, so its own routes are all served by `index.html` with no rewrite. The shipped `.htaccess` does add one `mod_rewrite` rule — it maps the pretty share URLs (`/s/<id>`) to `api/share.php` so links unfurl with a preview — along with the site's security headers. It needs `mod_rewrite` and `mod_headers`; both rules are wrapped in `<IfModule>` guards, so the site still works (minus pretty share links / headers) on a host where they're unavailable.

---

## Share link API

`api/share.php` handles short links for sharing builds:

| Method | Parameters                                                                                                                                                                                                                                      | Response                                                                           |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `POST` | JSON body `{ classId, specId, builds: ["…","…"] }` — 2–5 build strings, each ≤ 2000 chars. Optional: `labels` (array parallel to `builds`, each ≤ 40 chars — the per-slot names) and `className`/`specName` (≤ 64 chars, used by the OG image). | `{ id }` — 6-char alphanumeric                                                     |
| `GET`  | `?id=xxxxxx`                                                                                                                                                                                                                                    | Stored JSON payload (includes `labels`/`className`/`specName` when they were sent) |

Rows older than 90 days are deleted on each `POST` request.

### Security & limits

`share.php` is hardened for public exposure:

- **Per-IP rate limit** — 20 creates per IP per hour (`429` past that), tracked via a
  salted IP hash; set `SHARE_IP_SALT` in `config.php` to a random secret. Behind a
  trusted reverse proxy/CDN, also set `TRUST_PROXY` so the limit keys on the real
  client (the first `X-Forwarded-For` hop) instead of the proxy address.
- **Body cap** — requests over 16 KB are rejected (`413`) before parsing; JSON depth is capped.
- **Strict validation** — `classId`/`specId` must be positive integers, 2–5 builds, each a
  base64 build string ≤ 2000 chars; only the validated fields are stored (never the raw body).
- **Same-origin only** — no CORS headers are sent, so other sites can't call the API from a browser.
- **No error leakage** — DB/runtime errors return a generic JSON message; details are never exposed.
- All queries use prepared statements; IDs use a CSPRNG (`random_int`).

## Sharing

Two ways to share builds:

- **Copy link** — POSTs the builds to `api/share.php`, which returns a 6-char id; the
  link is `…/#xxxxxx` (or `…/s/xxxxxx`). Persistent, short, backed by the DB.
- **Copy instant link** — encodes the builds straight into the URL hash
  (`…/#b=<token>`, base64url of the build strings). No server call, no rate limit,
  works offline; the trade-off is a long URL. Opening either kind loads the builds
  on page load (a share in the URL takes precedence over locally saved state).

## Local persistence

Your work is autosaved to the browser's `localStorage` (key `comparebuilds-state`),
so a page reload keeps any builds you've added and the in-progress interactive
selection. This is separate from the share API: it stays on your device, hits no
server, and isn't rate-limited. Only the small serialisable state is saved (the
build strings, spec/class, and interactive selection); the decoded trees are
rebuilt on load.

A share id in the URL (`…/#xxxxxx`) takes precedence — opening a shared link loads
that build instead of your saved local state. One caveat: a build string typed
into a slot but not yet submitted isn't saved, since it's only transient input.

## Development

```bash
npm install
npm run dev
```

The PHP API is not available in the local dev server. Sharing links will 404 locally — test that feature on the deployed site.

### Quality gate

`./validate.sh` runs the full CI gate locally, in the same order CI does — lint,
formatting, the per-language linters, the PHP and shell checks, tests, and the
build:

```bash
./validate.sh          # everything CI enforces
./validate.sh --clean  # reinstall deps with `npm ci` first (matches CI)
npm run format         # auto-fix formatting (Prettier)
```

The npm-based tools (ESLint, Prettier, stylelint, markdownlint, svgo, Vitest)
come with `npm install`. The standalone CLIs are optional locally — `validate.sh`
skips any that are missing with a notice, and CI pins them — but to run the whole
gate, install them too:

```bash
brew install shellcheck shfmt php-cs-fixer phpunit actionlint lychee
```

Link checking (lychee) runs in its own GitHub workflow, separate from the
deploy-gating CI; run it locally with `npm run links`.

## Talent data

The app reads only the normalised JSON in `src/data/` — it never talks to any
external data source at runtime. That normalised schema is the contract; how the
data is produced (the ingest script, a hand edit, or a different source) is an
implementation detail behind it.

### Build-string format

`src/lib/buildString.js` parses/encodes the game's native talent loadout string
(the same one the in-game UI and any calculator export). The wire format is fixed
by the game; only the _node list_ depends on the data. Importing and sharing
builds is not tied to any particular data provider.

### Tests

```bash
npm run lint        # ESLint (flat config) — also enforced in CI
npm test            # run all suites once (Vitest)
npm run test:watch  # watch mode
npm run coverage    # run with a coverage report (text + html in coverage/)
```

The suite spans the logic layer and the components (Vitest, several hundred tests
across a dozen-plus files in `src/`). The ones that specifically guard data
correctness — the most important to understand before editing `src/data/`:

- **`treeLogic.test.js`** — prerequisite/gate cascade logic.
- **`buildString.test.js`** — per-class encode→decode round-trips, so a data
  change that would silently misparse build strings fails here instead.
- **`buildFixtures.test.js`** — decodes real build strings exported from the
  in-game UI, confirming our node IDs/ordering/budgets match what the game emits.
- **`dataIntegrity.test.js`** — validates every class file against the schema
  (`validateClassData.js`) and checks each class's build-string **wire-layout
  snapshot** (`wireLayout.snapshot.json`).

The rest cover the store, the diff/heatmap logic, the HTML sanitiser, and the
React components.

The PHP share API has its own PHPUnit suite in `tests/`, covering the
public-input validation surface (id format, build-string limits, label/name
caps, and the client-IP handling). Run it with `phpunit`, or let `./validate.sh`
run everything — JavaScript, PHP, the linters, and the build — at once.

### Editing or repopulating the data

You can hand-edit `src/data/*.json` or regenerate it from any source. After any
change, run `npm test`:

- A **schema** failure means the file is structurally wrong (missing fields, bad
  node types, dangling connections, etc.) — fix it before shipping.
- A **wire-layout snapshot** failure means your change shifted build-string bit
  positions, so **every existing build string and share link for that class will
  now parse differently**. If that is intentional (e.g. a new game patch added
  nodes), regenerate the snapshot deliberately:

  ```bash
  UPDATE_SNAPSHOTS=1 npm test
  ```

Every importer runs the same validation on every class and refreshes the
snapshot automatically; it aborts without updating the snapshot if any class
fails validation.

### Sources: Blizzard (primary) + Icy Veins / Wowhead (fallbacks)

The data is sourced from Blizzard directly, with two scrapers kept ready as
fallbacks so it isn't hostage to a single upstream being offline or slow for a
new patch. All importers map their source to the same schema and hand off to the
shared pipeline in `scripts/lib/ingestCore.js`. Because every source uses
Blizzard's own trait-node IDs, build strings stay interchangeable across them,
and the wire-layout snapshot is the proof: a source whose fingerprints match the
committed snapshot is build-string-compatible.

- **`scripts/ingestBlizzard.js` (primary).** Reads Blizzard's official Game Data
  API for the tree structure, and the client's DB2 tables (via
  [wago.tools](https://wago.tools), `scripts/lib/blizzardDb2.js`) for the two
  things the web API doesn't expose cleanly: the spec **apex** capstone's true
  rank chain (it flattens that node to a single rank) and the authoritative
  per-node points gate. Needs a free Battle.net API client — copy `.env.example`
  to `.env` and fill in `BLIZZARD_CLIENT_ID`/`BLIZZARD_CLIENT_SECRET` (build-time
  only; never deployed). See [develop.battle.net](https://develop.battle.net/access/clients).
- **`scripts/ingestIcyVeins.js` / `scripts/ingestWowhead.js` (fallbacks).**
  Prepared alternate importers; `--promote` switches the live writer.

```bash
node scripts/ingestBlizzard.js                # verify Blizzard vs the snapshot + schema (writes nothing)
node scripts/ingestBlizzard.js --promote      # make Blizzard the live source (writes src/data/)
node scripts/compareSources.js --source=blizzard   # diff Blizzard (API+DB2) vs the committed data
node scripts/compareSources.js                # diff Wowhead vs the committed data (default source)
node scripts/fetchIcons.js                    # download any newly-referenced icons (commit the result)
```

`compareSources.js` separates **hard** divergences — the build-string wire
layout, ranks, choice arity, gates, and prerequisites, which must agree — from
**soft** ones (positions, names, descriptions, and the occasional per-spec
membership difference where sources disagree about display). It runs in the
non-gating `sources.yml` workflow, kept out of the release gate because it
fetches live upstreams. Descriptions reflect _current_ game data and so differ
between sources; description text doesn't affect build strings or any gate.
Because Blizzard's layout is the game's own grid, promoting it re-lays-out every
tree (positions are soft) and may change icon filenames — re-run
`scripts/fetchIcons.js` after a promote and commit the new icons.

To add yet another source, write a sibling importer that emits the same schema
and reuses `ingestCore.js`; the validator, snapshot, and `compareSources.js` will
tell you when the output is correct.

## License

[MIT](LICENSE) © Markus Spitzner

This is an unofficial fan project, not affiliated with or endorsed by Blizzard
Entertainment. World of Warcraft and all related talent data, names, and icons
are trademarks or registered trademarks of Blizzard Entertainment, Inc.

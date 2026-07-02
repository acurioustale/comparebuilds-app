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
(`api/share.php`, `api/og.php`, `api/lib/`, `api/fonts/`, `api/cron/`, `api/current_layouts.json`) into one tree and mirrors it with a
single `rsync -avz --delete` to the web root:

```text
web4186@http2.core-networks.de:html/comparebuilds.app/
```

Staging the two sources into one tree is what makes `--delete` safe: `dist/` has
no `api/`, so deleting against `dist/` alone would wipe the live API folder. For
the same reason the staged list must include every runtime dependency of the API:
`api/lib/` holds `RateLimiter.php`, which `share.php` requires, so leaving it out
makes `--delete` remove it from the server and fatal every share/OG request; and
`api/current_layouts.json` is the manifest `ensure_schema.php` reconciles into the
layout-history table, so dropping it lets `--delete` remove it and silently breaks
supersession-gated pruning (the cron can no longer tell current layouts from
superseded ones).
`config.php` (below) lives one level above the web root and is never touched.
After a successful rsync, `deploy.sh` runs `api/cron/ensure_schema.php` over SSH
to apply any pending schema migrations.

CI authenticates with a dedicated SSH deploy key, stored as the repository
secrets `DEPLOY_SSH_KEY` and `DEPLOY_KNOWN_HOSTS`. The key is harmless if leaked:
on the host it's pinned to a forced command
(`~web4186/bin/rsync-jail-comparebuilds.sh`, wired up in that account's
`authorized_keys`) that allows only an rsync _push_ into `html/comparebuilds.app/`
plus the one exact schema-migration command `deploy.sh` runs after it — no shell,
no pull, and no path traversal outside that directory. This is why the deploy
target in `deploy.sh` must keep its trailing slash; the jail matches on that exact
prefix. The jail's reviewed source is tracked at
[`ops/rsync-jail-comparebuilds.sh`](ops/rsync-jail-comparebuilds.sh); the copy on
the host is authoritative, so after editing it there re-install it with
`scp ops/rsync-jail-comparebuilds.sh web4186@http2.core-networks.de:bin/`. Any new
`ssh` command added to `deploy.sh` needs a matching entry in the jail (and a
reinstall), or the deploy fails with `rsync-jail: only rsync push allowed`.

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

Upload the **contents** of `dist/` to the web root folder (the folder that comparebuilds.app points to). Upload `api/share.php`, `api/og.php`, `api/current_layouts.json`, and the `api/lib/`, `api/cron/`, and `api/fonts/` folders into an `api/` subfolder inside that same web root. `api/lib/` holds `RateLimiter.php`, which `share.php` requires — omitting it makes both `share.php` and `og.php` fatal. `api/current_layouts.json` is the manifest `ensure_schema.php` reconciles after deploy; omitting it breaks supersession-gated pruning.

`og.php` renders the Open Graph preview image for shared links and needs PHP's **GD** extension with FreeType (for text). It ships its own bold TTF in `api/fonts/`, so no system fonts are required; set `OG_FONT_PATH` in `config.php` only to override it. It emits whichever image format the host's GD supports (PNG → JPEG → GIF → WebP), so it works even on GD builds without PNG. Make sure the `api/fonts/` folder is uploaded alongside `og.php`. Pretty share URLs (`/s/<id>`) rely on `mod_rewrite` (configured in the shipped `.htaccess`).

Expected layout on the server:

```text
/home/username/
├── config.php          ← credentials file, above the web root
├── cache_og/           ← OG image cache, auto-created by og.php, above the web root
└── www/                ← web root (comparebuilds.app → this folder)
    ├── index.html
    ├── .htaccess        ← shipped from dist/ (mod_rewrite for /s/<id>, security headers)
    ├── assets/
    ├── talent-icons/    ← self-hosted talent icons (committed; see scripts/fetchIcons.js)
    └── api/
        ├── share.php
        ├── og.php
        ├── current_layouts.json  ← build-generated manifest of current layout hashes (ensure_schema.php reconciles it)
        ├── lib/
        │   └── RateLimiter.php   ← required by share.php (and og.php via share.php)
        ├── cron/
        │   ├── prune_shares.php
        │   └── ensure_schema.php
        └── fonts/
            └── DejaVuSans-Bold.ttf
```

`cache_og/` sits **beside** `config.php`, one level above the web root — not inside it — so the `rsync --delete` mirror can't wipe it on each deploy and `prune_shares.php` (which cleans it) resolves the same path `og.php` writes.

### 3. Create config.php above the web root

Copy `api/config.php.example` to `/home/username/config.php` (one level above the web root) and fill in your MariaDB credentials:

```php
<?php
define('DB_HOST', 'localhost');
define('DB_NAME', 'your_database_name');
define('DB_USER', 'your_db_user');
define('DB_PASS', 'your_db_password');

// Optional: Redis for high-performance rate limiting and concurrency locking.
// If defined and the Redis extension is available, share.php and og.php will
// use Redis, gracefully falling back to MySQL GET_LOCK and database rate
// limiting if Redis is unavailable.
// define('REDIS_HOST', '127.0.0.1');
// define('REDIS_PORT', 6379);

// Recommended: a random secret used to salt the hashed client IPs stored for
// rate limiting. Generate once, e.g. `openssl rand -hex 32`.
define('SHARE_IP_SALT', 'change-me-to-a-long-random-string');

// Optional: set to true ONLY if behind a reverse proxy/CDN. When true,
// per-IP rate limiting keys on X-Forwarded-For instead of REMOTE_ADDR.
// define('TRUST_PROXY', true);
// define('TRUSTED_PROXIES', ['10.0.0.0/8', '172.16.0.0/12']);
// define('TRUST_CLOUDFLARE', true);
// define('TRUST_X_REAL_IP', true);

// Optional: canonical site origin for OG tags. Defaults to https://comparebuilds.app.
// define('SITE_ORIGIN', 'https://comparebuilds.app');

// Optional: absolute path to a bold .ttf for the OG image text. og.php probes
// the usual DejaVu/Liberation locations; set this only if your host differs.
// define('OG_FONT_PATH', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf');
```

This location keeps the credentials inaccessible to the public even if PHP processing were to fail.

### 4. Create the database table

`share.php` runs `CREATE TABLE IF NOT EXISTS` on the first share **creation** (the
`POST` path), so the table is created automatically on first use. You can also
create it manually via your MariaDB/MySQL client (phpMyAdmin, CLI, or your host's
database tool):

```sql
CREATE TABLE IF NOT EXISTS comparebuilds_shares (
    id         VARCHAR(32) NOT NULL PRIMARY KEY,
    data       MEDIUMTEXT  NOT NULL,
    ip_hash    CHAR(64)    NULL,
    created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_created (created_at),
    INDEX idx_ip_created (ip_hash, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

`ip_hash` stores a salted SHA-256 of the creator's IP, used only for per-IP rate
limiting (20 shares/hour by default).

### 5. Configure the pruning cron job

In your hosting control panel or crontab (`crontab -e`), configure a daily overnight job to execute `api/cron/prune_shares.php`. This script safely purges share links whose talent layout has been superseded (by a game patch) and that have then gone unaccessed for 180 days (~6 months) — a still-current or actively-opened link is never pruned:

```bash
30 3 * * * /usr/bin/php $HOME/html/comparebuilds.app/api/cron/prune_shares.php >/dev/null 2>&1
```

### 6. Point the domain

In your hosting control panel, point the `comparebuilds.app` domain to the web root folder you uploaded to. The SPA itself uses hash-based routing, so its own routes are all served by `index.html` with no rewrite. The shipped `.htaccess` does add one `mod_rewrite` rule — it maps the pretty share URLs (`/s/<id>`) to `api/share.php` so links unfurl with a preview — along with the site's security headers. It needs `mod_rewrite` and `mod_headers`; both rules are wrapped in `<IfModule>` guards, so the site still works (minus pretty share links / headers) on a host where they're unavailable.

### 7. Set up the CI deploy key (optional — only for automated deploys)

Hand deploys (`./deploy.sh`) use your own SSH access and need none of this. To let GitHub Actions deploy on push to `main`, give it a dedicated, jailed key:

1. Generate a key pair with no passphrase (so CI can use it non-interactively):

   ```bash
   ssh-keygen -t ed25519 -N '' -C comparebuilds-deploy -f comparebuilds-deploy
   ```

2. Install the jail script on the host and make it executable:

   ```bash
   scp ops/rsync-jail-comparebuilds.sh web4186@http2.core-networks.de:bin/
   ssh web4186@http2.core-networks.de 'chmod +x ~/bin/rsync-jail-comparebuilds.sh'
   ```

3. Add the **public** key to the host's `~/.ssh/authorized_keys`, pinned to the jail as a forced command with `restrict` (which disables pty, port/agent/X11 forwarding, and user-rc):

   ```text
   command="/home/www/web4186/bin/rsync-jail-comparebuilds.sh",restrict ssh-ed25519 <public key> comparebuilds-deploy
   ```

   The jail (see [`ops/rsync-jail-comparebuilds.sh`](ops/rsync-jail-comparebuilds.sh)) allow-lists exactly the SSH commands `deploy.sh` issues — the rsync push and the `ensure_schema.php` migration — so add a matching entry there for any new one, or the deploy fails with `rsync-jail: only rsync push allowed`. Each site on a shared account gets its own key and jail.

4. Store the **private** key as the repo secret `DEPLOY_SSH_KEY`, and the host's SSH host key (`ssh-keyscan http2.core-networks.de`) as `DEPLOY_KNOWN_HOSTS`.

---

## Share link API

`api/share.php` handles short links for sharing builds:

| Method | Parameters                                                                                                                                                                                                                                                                                                                     | Response                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `POST` | JSON body `{ classId, specId, builds: ["…","…"] }` — 2–5 build strings, each ≤ 2000 chars. Optional: `labels` (array parallel to `builds`, each ≤ 40 chars — the per-slot names), `className`/`specName` (≤ 64 chars, used by the OG image), and `layoutHash` (≤ 16-char hex structural fingerprint of the class wire layout). | `{ id }` — 8–16 char alphanumeric, content-addressed (see below)                                |
| `GET`  | `?id=<id>`                                                                                                                                                                                                                                                                                                                     | Stored JSON payload (includes `labels`/`className`/`specName`/`layoutHash` when they were sent) |

Retention is **supersession-gated**, not a flat age. A `GET` touches the row's `last_accessed` (debounced to one write per day; note the response is cached `immutable`, so this fires only on a cold-cache open), and each build stamps the row's `layout_hash`. A standalone daily cron script (`api/cron/prune_shares.php`) deletes a share only once its layout is no longer current **and** the link has gone unaccessed for 180 days (~6 months) **and** the layout itself was superseded at least that long ago — so a still-current or actively-opened link is never pruned, while the whole idle window falls after supersession. The server learns which layouts are current from `api/current_layouts.json`, a build-generated manifest that `ensure_schema.php` reconciles into `comparebuilds_layout_history` after each deploy (any hash that drops out of the manifest is stamped superseded). Legacy rows with no `layout_hash` age out on the unaccessed clock alone. Pruning stays completely decoupled from live API requests, so table cleanup never adds request latency.

Ids are **content-addressed**: the id is a base62 prefix (8 chars, lengthened to
at most 16 on a collision) of the SHA-256 of the canonicalised payload, so sharing
the same build twice returns the same id instead of creating a duplicate row.

### Security & limits

`share.php` is hardened for public exposure:

- **Per-IP rate limit** — 20 creates per IP per hour (`429` past that), tracked via a
  salted IP hash; set `SHARE_IP_SALT` in `config.php` to a random secret. Behind a
  trusted reverse proxy/CDN, set `TRUST_PROXY` so the limit keys on the real client
  (the last `X-Forwarded-For` hop) instead of the proxy address. For Cloudflare or
  Nginx, explicitly define `TRUST_CLOUDFLARE` or `TRUST_X_REAL_IP` to trust those headers.
- **Body cap** — requests over 16 KB are rejected (`413`) before parsing; JSON depth is capped.
- **Strict validation** — `classId`/`specId` must be positive integers, 2–5 builds, each a
  base64 build string ≤ 2000 chars; only the validated fields are stored (never the raw body).
- **Same-origin only** — no CORS headers are sent, so other sites can't call the API from a browser.
- **No error leakage** — DB/runtime errors return a generic JSON message; details are never exposed.
- All queries use prepared statements; ids are content-addressed (a base62 prefix of the payload's SHA-256), not user-controlled.

## Sharing

**Copy link** POSTs the builds to `api/share.php`, which returns a content-addressed
id; the link is `…/s/<id>` (the SPA also opens a bare `…/#<id>` hash). It's
persistent, short, backed by the DB, and unfurls with an Open Graph preview card.
Opening a share link loads the builds on page load (a share in the URL takes
precedence over locally saved state).

The share embeds a detect-only `layoutHash` stamp — a structural fingerprint of the talent tree at the time of sharing. If a game patch shifts talent positions or alters the tree structure, opening an older share link renders the trees best-effort and displays an honest warning banner: the builds were saved for an earlier talent revision, and some talents may have moved, changed, or dropped out, so the comparison should be treated as approximate — rather than silently misparsing or rendering a corrupt build with no notice. The same `layoutHash` also drives supersession-gated retention server-side (see the share-link API section).

## Local persistence

Your work is autosaved to the browser's `localStorage` (key `comparebuilds-state`),
so a page reload keeps any builds you've added and the in-progress interactive
selection. This is separate from the share API: it stays on your device, hits no
server, and isn't rate-limited. Only the small serialisable state is saved (the
build strings, spec/class, and interactive selection); the decoded trees are
rebuilt on load.

A share id in the URL (`…/#<id>`) takes precedence — opening a shared link loads
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
formatting, the per-language linters, the PHP and shell checks, tests, the build,
a CSP guard (`npm run check:csp`) that recomputes the sha256 of the built
inline anti-flash theme script and fails if its hash has drifted from either
Content-Security-Policy that allowlists it — the `<meta>` baseline injected into
the built HTML and the `.htaccess` header superset — or if the two policies
disagree on any other directive, an OG image guard
(`npm run check:og`) that verifies `public/og-image.png` is 1200×630, a
sitemap well-formedness check (`xmllint --noout dist/sitemap.xml`), and HTML
validation (the Nu Html Checker over `dist/` — the entry page, every prerendered
spec landing page and the SVG favicon):

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
brew install shellcheck shfmt php-cs-fixer phpunit actionlint lychee xmllint vnu
```

Link checking (lychee) runs in its own GitHub workflow, separate from the
deploy-gating CI; run it locally with `npm run links`. PHP static analysis
(Semgrep) runs the same way — its own non-gating workflow that uploads results to
GitHub code scanning (the Security tab), covering the `api/*.php` endpoints that
CodeQL's default setup can't (CodeQL has no PHP support).

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
caps, client-IP handling), concurrency (`ShareConcurrencyTest.php`), the
supersession-retention helpers (`LayoutRetentionTest.php`), and the OG
image renderer (`OgRenderTest.php`). Run it with `phpunit`, or let `./validate.sh`
run everything — JavaScript, PHP, the linters, and the build — at once.

Cross-stack parity tests keep the JS and PHP mirrors in sync: `limitsParity.test.js`
pins `MAX_BUILDS`/`MAX_BUILD_LEN`/`MAX_BUILD_NAME_LEN` in `slices/constants.js` against
`api/share.php`, and `shareIdParity.test.js` pins the share-id regex in `route.js`
against both `share.php` and `og.php`. A change to one side that forgets the other
fails the gate.

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

The ingest runs the same validation on every class. Passing `--promote
--update-snapshot` regenerates the snapshot too — merging the promoted classes'
fingerprints into the existing file — and aborts without updating it if any class
fails validation. `--promote` alone writes `src/data/` and leaves the snapshot
untouched.

### Source: Blizzard (Game Data API + client DB2)

The data comes straight from Blizzard. `scripts/ingestBlizzard.js` reads
Blizzard's official **Game Data API** for the tree structure, and the client's
**DB2** tables (via [wago.tools](https://wago.tools),
`scripts/lib/blizzardDb2.js`) for the things the web API doesn't expose cleanly:
the spec **apex** capstone's true rank chain (distinct per-rank spells, ranks,
and unlock levels), the authoritative per-node points gate, and hero-subtree
descriptions. It maps everything to the shared schema and hands off to the
pipeline in `scripts/lib/ingestCore.js`.

Needs a free Battle.net API client — copy `.env.example` to `.env` and fill in
`BLIZZARD_CLIENT_ID`/`BLIZZARD_CLIENT_SECRET` (build-time only; never deployed).
See [develop.battle.net](https://develop.battle.net/access/clients).

```bash
node scripts/ingestBlizzard.js                # verify vs the snapshot + schema (writes nothing)
node scripts/ingestBlizzard.js --promote      # regenerate src/data/ from Blizzard
node scripts/compareSources.js                # re-derive from Blizzard live and diff vs committed
node scripts/fetchIcons.js                    # download any newly-referenced icons (commit the result)
```

`compareSources.js` is the drift/freshness check: it re-derives the data from
Blizzard and diffs it against the committed `src/data`, separating **hard**
divergences — the build-string wire layout, ranks, choice arity, gates, and
prerequisites, which must agree — from **soft** ones (positions, names,
descriptions, per-spec membership). It runs in the non-gating `sources.yml`
workflow (it needs the API secrets and fetches live), so a red run means the
committed data has drifted from a new game patch — investigate, not a blocked
release. Icons come first-party from Blizzard's render CDN; re-run
`scripts/fetchIcons.js` after an ingest that adds new icons and commit them.

The pipeline is source-agnostic: a new source can be added by writing a sibling
importer that emits the same schema and reuses `ingestCore.js` — the validator,
snapshot, and `compareSources.js` tell you when the output is correct. (Icy Veins
and Wowhead were earlier sources, removed once Blizzard + DB2 fully replaced
them.)

## Security

To report a vulnerability, follow the [security policy](SECURITY.md) — please use
a private channel (GitHub's private vulnerability reporting or email) rather than
a public issue. The share API's own request hardening and limits are documented
under "Share link API" above.

Findings from automated scanning surface in the repository's GitHub Security tab:
CodeQL (JavaScript/TypeScript), Semgrep (the PHP endpoints), and Dependabot for
vulnerable dependencies, alongside secret-scanning push protection.

## License

[MIT](LICENSE) © Markus Spitzner

This is an unofficial fan project, not affiliated with or endorsed by Blizzard
Entertainment. World of Warcraft and all related talent data, names, and icons
are trademarks or registered trademarks of Blizzard Entertainment, Inc.

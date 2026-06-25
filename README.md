# comparebuilds

WoW talent build comparison tool — deployed at comparebuilds.app.

## Deployment

### 1. Build the frontend

```bash
npm run build
```

This produces a `dist/` folder containing the static site.

### 2. Upload files to the server

Upload the **contents** of `dist/` to the web root folder (the folder that comparebuilds.app points to). Upload `api/share.php` and `api/og.php` into an `api/` subfolder inside that same web root.

`og.php` renders the Open Graph preview image for shared links and needs PHP's **GD** extension (with FreeType for text — standard on most hosts). It auto-detects a bold TTF in the usual DejaVu/Liberation locations; set `OG_FONT_PATH` in `config.php` if your host keeps fonts elsewhere. Pretty share URLs (`/s/<id>`) rely on `mod_rewrite` (configured in the shipped `.htaccess`).

Expected layout on the server:

```
/home/username/
├── config.php          ← credentials file, above the web root
└── www/                ← web root (comparebuilds.app → this folder)
    ├── index.html
    ├── assets/
    ├── sw.js
    └── api/
        └── share.php
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

In your hosting control panel, point the `comparebuilds.app` domain to the web root folder you uploaded to. No `.htaccess` rewrite rules are needed — the app uses hash-based routing and all routes are served by `index.html`.

---

## Share link API

`api/share.php` handles short links for sharing builds:

| Method | Parameters | Response |
|--------|-----------|----------|
| `POST` | JSON body `{ classId, specId, builds: ["…","…"] }` — 2–5 build strings, each ≤ 2000 chars. Optional: `labels` (array parallel to `builds`, each ≤ 40 chars — the per-slot names) and `className`/`specName` (≤ 64 chars, used by the OG image). | `{ id }` — 6-char alphanumeric |
| `GET`  | `?id=xxxxxx` | Stored JSON payload (includes `labels`/`className`/`specName` when they were sent) |

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

## Talent data

The app reads only the normalised JSON in `src/data/` — it never talks to any
external data source at runtime. That normalised schema is the contract; how the
data is produced (the ingest script, a hand edit, or a different source) is an
implementation detail behind it.

### Build-string format

`src/lib/buildString.js` parses/encodes the game's native talent loadout string
(the same one the in-game UI and any calculator export). The wire format is fixed
by the game; only the *node list* depends on the data. Importing and sharing
builds is not tied to any particular data provider.

### Tests

```bash
npm run lint        # ESLint (flat config) — also enforced in CI
npm test            # run all suites once (Vitest)
npm run test:watch  # watch mode
npm run coverage    # run with a coverage report (text + html in coverage/)
```

The suite spans the logic layer and the components (Vitest, ~390 tests across a
dozen files in `src/`). The ones that specifically guard data correctness — the
most important to understand before editing `src/data/`:

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

`scripts/ingestTalentData.js` (the current Icy Veins importer) runs the same
validation on every class and refreshes the snapshot automatically; it aborts
without updating the snapshot if any class fails validation. To target a
different source, rewrite its normaliser to emit the same schema — the validator
and round-trip tests will tell you when the output is correct.

## License

[MIT](LICENSE) © Markus Spitzner

This is an unofficial fan project, not affiliated with or endorsed by Blizzard
Entertainment. World of Warcraft and all related talent data, names, and icons
are trademarks or registered trademarks of Blizzard Entertainment, Inc.

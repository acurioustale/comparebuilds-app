# Security Policy

`comparebuilds` is a static single-page app deployed at
[comparebuilds.app](https://comparebuilds.app), backed by a small PHP share-link
API (`api/share.php`) and an Open Graph image endpoint (`api/og.php`). Those two
endpoints are the only internet-facing server code; everything else is static
files served to the browser.

## Supported versions

The project is continuously deployed from `main` — there are no tagged releases.
Only the **currently deployed `main`** (i.e. what is live at comparebuilds.app)
is supported. Please report issues against the latest `main`.

## Reporting a vulnerability

**Please do not open a public issue for security problems.** Use a private
channel so the report isn't visible before a fix ships:

- **Preferred:** GitHub's private vulnerability reporting —
  _Security → Report a vulnerability_ on this repository.
- **Email:** <me@acurioustale.de>

The same contacts are published in machine-readable form at
<https://comparebuilds.app/.well-known/security.txt> (RFC 9116).

Please include:

- a description of the issue and its impact,
- steps to reproduce (a request, payload, or build string is ideal),
- the affected endpoint or component, and
- any proof-of-concept you have.

## Scope

### In scope

- The live site and SPA at comparebuilds.app.
- The share-link API (`api/share.php`) — e.g. injection, auth/rate-limit bypass,
  data exposure.
- The OG image endpoint (`api/og.php`).
- Build-string decoding/encoding (`src/lib/buildString.js`) and other client
  logic where a crafted input causes a real security impact.

### Out of scope

- Third-party services the build pipeline reads (Blizzard APIs, wago.tools) and
  any third-party CDN — report those to the respective vendor.
- The World of Warcraft game or its data.
- Volumetric denial of service / brute-forcing the existing rate limits.
- Self-XSS, or missing "best-practice" headers without a demonstrated impact.
- Social engineering and physical attacks.

## What to expect

This is a single-maintainer hobby project, so response is best-effort:

- I aim to acknowledge a report within **5 business days**.
- I'll keep you updated on the assessment and a fix timeline.
- Fixes deploy from `main`; I'm happy to credit you once the fix is live, unless
  you prefer to stay anonymous.

Good-faith research under this policy is welcome — please avoid privacy
violations, data destruction, and any disruption to other users' service while
testing.

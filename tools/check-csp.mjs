// Verify the Content-Security-Policy still covers every inline script that ships.
// The single inline <script> the build emits is the anti-flash theme resolver in
// index.html; it runs under script-src, which forbids 'unsafe-inline', so it is
// allowlisted by its sha256 hash in the .htaccess header CSP. This recomputes the
// hash from the built markup and fails if it is missing from the policy — so the
// hash can't silently drift when the inline script is edited (which would block
// the script and reintroduce the theme flash). Run from validate.sh and deploy.yml.
//
// It checks the BUILT artifacts in dist/ (not source), so it validates exactly
// what ships and catches any Vite transform of the inline script. That means it
// must run after `npm run build`.
//
// This project has a single policy — the .htaccess header; there is no <meta> CSP.
//
// Dependency-free on purpose: small regexes over our own well-formatted files,
// not a general HTML/Apache parser.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const distHtml = new URL("../dist/index.html", import.meta.url);
const distHtaccess = new URL("../dist/.htaccess", import.meta.url);

let html;
try {
  html = await readFile(distHtml, "utf8");
} catch {
  console.error(
    "check-csp: dist/index.html not found - run `npm run build` first.",
  );
  process.exit(1);
}
const htaccess = await readFile(distHtaccess, "utf8");

// The header CSP: Header always set Content-Security-Policy "...".
const csp = htaccess.match(/Content-Security-Policy\s+"([^"]*)"/i)?.[1];
if (!csp) {
  console.error(
    "check-csp: no Content-Security-Policy found in dist/.htaccess header.",
  );
  process.exit(1);
}

// Every <script> element in index.html, capturing opening-tag attributes + body.
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];

let failed = false;
for (const [, attrs, body] of scripts) {
  if (/\bsrc=/i.test(attrs)) continue; // external: covered by script-src 'self'
  const type = (attrs.match(/\btype=["']([^"']*)["']/i) || [])[1];
  // Non-JS data blocks (e.g. application/ld+json) are not executed and so are
  // not subject to script-src; only real inline scripts need a hash.
  const isJs =
    !type || /^(module|text\/javascript|application\/javascript)$/i.test(type);
  if (!isJs) continue;

  const hash = createHash("sha256").update(body, "utf8").digest("base64");
  const token = `'sha256-${hash}'`;
  if (!csp.includes(token)) {
    failed = true;
    console.error(
      `check-csp: inline script not allowed by the .htaccess header CSP.\n  expected token: ${token}`,
    );
  }
}

if (failed) process.exit(1);
console.log("check-csp: all inline scripts are covered by the CSP");

// Verify both Content-Security-Policies still cover every inline script that
// ships, and that the two stay in lock-step. The policy is declared twice: a
// <meta> tag in the built index.html (injected by the cspMetaPlugin in
// vite.config.js — the locally-testable, defence-in-depth baseline) and the
// HTTP header in .htaccess (the production superset). Each runs the single
// inline <script> the build emits (the anti-flash theme resolver) under
// script-src, which forbids 'unsafe-inline', so it is allowlisted by its sha256
// hash in BOTH policies. This recomputes the hash from the built markup and
// fails if it is missing from either policy, and also checks the two policies
// agree on every other directive — so neither can silently drift, whether the
// inline script is edited or a directive is loosened in only one file. Run from
// validate.sh and deploy.yml.
//
// It checks the BUILT artifacts in dist/ (not source), so it validates exactly
// what ships and catches any Vite transform of the inline script (and confirms
// the plugin actually injected the meta). That means it must run after
// `npm run build`.
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

// The <meta> CSP (attribute order between http-equiv and content is irrelevant).
let metaCsp;
for (const [tag] of html.matchAll(
  /<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi,
)) {
  const match = tag.match(/content=(["'])([\s\S]*?)\1/i);
  if (match) metaCsp = match[2];
}

// The header CSP: the `Header [always] set Content-Security-Policy "..."`
// directive in .htaccess. Scan line by line and skip Apache comments so a
// commented-out example can't be captured instead of the live directive, and
// require the `Header set` form so a bare mention in prose never matches.
let headerCsp;
for (const rawLine of htaccess.split("\n")) {
  const line = rawLine.trim();
  if (line.startsWith("#")) continue;
  const match = line.match(
    /^Header\s+(?:always\s+)?set\s+Content-Security-Policy\s+"([^"]*)"/i,
  );
  if (match) {
    headerCsp = match[1];
    break;
  }
}

const policies = [
  { name: "index.html <meta> CSP", csp: metaCsp },
  { name: ".htaccess header CSP", csp: headerCsp },
];

let failed = false;
for (const { name, csp } of policies) {
  if (!csp) {
    failed = true;
    console.error(`check-csp: no Content-Security-Policy found in ${name}`);
  }
}
if (failed) process.exit(1);

// A CSP as a map of directive name -> set of values, so the two policies can be
// compared directive by directive, order- and whitespace-insensitively.
function parseCsp(csp) {
  const directives = new Map();
  for (const part of csp.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/).filter(Boolean);
    if (name) directives.set(name.toLowerCase(), new Set(values));
  }
  return directives;
}

// Directives the .htaccess header carries that a <meta> CSP cannot express: the
// header is allowed to add exactly these on top of the <meta> baseline.
const HEADER_ONLY = new Set(["frame-ancestors", "upgrade-insecure-requests"]);

// Human-readable list of directives that differ between two CSP maps.
function directiveDiff(meta, header) {
  const diffs = [];
  for (const name of new Set([...meta.keys(), ...header.keys()])) {
    const m = meta.get(name);
    const h = header.get(name);
    if (!m) diffs.push(`${name}: only in .htaccess`);
    else if (!h) diffs.push(`${name}: only in <meta>`);
    else if (m.size !== h.size || ![...m].every((v) => h.has(v)))
      diffs.push(
        `${name}: <meta> [${[...m].join(" ")}] vs .htaccess [${[...h].join(" ")}]`,
      );
  }
  return diffs;
}

// The two policies must stay in lock-step: strip the header-only directives,
// then the rest must match exactly, so loosening or dropping a directive in only
// one file is caught — not just a drifted script hash.
const headerBaseline = new Map(
  [...parseCsp(headerCsp)].filter(([name]) => !HEADER_ONLY.has(name)),
);
const diffs = directiveDiff(parseCsp(metaCsp), headerBaseline);
if (diffs.length) {
  failed = true;
  console.error(
    "check-csp: the <meta> and .htaccess CSPs disagree (header-only " +
      "frame-ancestors/upgrade-insecure-requests excluded):",
  );
  for (const d of diffs) console.error(`  ${d}`);
}

// Every <script> element in index.html, capturing opening-tag attributes + body.
// The end tag can carry trailing whitespace or junk up to the `>` (e.g.
// `</script >` or `</script\n foo>`), which browsers still treat as a close, so
// match `</script\b[^>]*>` — a bare `</script>` would miss those forms and skip
// the element. The `\b` keeps it from matching a different tag like
// `</scriptx>`. Mirrors the opening-tag pattern (CodeQL js/bad-tag-filter).
const scripts = [
  ...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi),
];

let inlineJsCount = 0;
for (const [, attrs, body] of scripts) {
  if (/\bsrc=/i.test(attrs)) continue; // external: covered by script-src 'self'
  const type = (attrs.match(/\btype=["']([^"']*)["']/i) || [])[1];
  // Non-JS data blocks (e.g. application/ld+json) are not executed and so are
  // not subject to script-src; only real inline scripts need a hash.
  const isJs =
    !type || /^(module|text\/javascript|application\/javascript)$/i.test(type);
  if (!isJs) continue;

  inlineJsCount++;
  const hash = createHash("sha256").update(body, "utf8").digest("base64");
  const token = `'sha256-${hash}'`;
  for (const { name, csp } of policies) {
    if (!csp.includes(token)) {
      failed = true;
      console.error(
        `check-csp: inline script not allowed by the ${name}.\n  expected token: ${token}`,
      );
    }
  }
}

// Floor assertion: the build always emits the anti-flash theme script inline, so
// matching zero inline JS scripts means the markup or the regex above drifted and
// the loop verified nothing. Without this, the guard would print success and exit
// 0 as a silent no-op, letting an unhashed inline script ship (blocked at runtime
// by the CSP, reintroducing the theme flash). Fail loudly instead.
if (inlineJsCount === 0) {
  console.error(
    "check-csp: found no inline <script> to hash in dist/index.html - the\n" +
      "  markup or the matching regex has drifted, so this guard verified nothing.\n" +
      "  Refusing to green-light an unchecked CSP.",
  );
  process.exit(1);
}

if (failed) process.exit(1);
console.log(
  "check-csp: the two CSPs are consistent and cover all inline scripts",
);

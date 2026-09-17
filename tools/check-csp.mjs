// Verify both Content-Security-Policies still cover every inline script that
// ships, and that the two stay in lock-step. The policy is declared twice: a
// <meta> tag in the built index.html (injected by the cspMetaPlugin in
// vite.config.js — the locally-testable, defence-in-depth baseline) and the
// HTTP header in .htaccess (the production superset). Each inline <script> the
// build emits (today just the anti-flash theme resolver) runs under script-src,
// which forbids 'unsafe-inline', so it is allowlisted by its sha256 hash in
// BOTH policies. This recomputes the hash from the built markup and fails if it
// is missing from either policy, and also checks the two policies agree on
// every other directive — so neither can silently drift, whether the inline
// script is edited or a directive is loosened in only one file. Run from
// validate.sh and deploy.yml.
//
// It checks the BUILT artifacts in dist/ (not source), so it validates exactly
// what ships and catches any Vite transform of the inline script (and confirms
// the plugin actually injected the meta). That means it must run after
// `npm run build`.
//
// Dependency-free on purpose, but not regex-by-hand: every parsing rule it
// needs — quote-aware tag scanning, comment skipping, attribute parsing, CSP
// directive parsing, the Apache header read — lives in a tools/ helper with a
// test of its own, so a rule that is subtly wrong on real input fails a test
// rather than silently validating something other than what ships.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isInlineScript, scriptElements } from "./shared/inline-scripts.mjs";
import { findTags, countRawTextOpeners } from "./shared/html-tags.mjs";
import { readHeaderCsp } from "./shared/htaccess-csp.mjs";
import { parseCsp, comparePolicies } from "./shared/csp-directives.mjs";

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

// The <meta> CSP, read through the shared tools/shared/html-tags.mjs scanner: it finds
// the <meta> tags (quote-aware, and tag-name anchored so a different element
// like <metadata> can't be read as the policy source) and skips any inside an
// HTML comment, so a documented sample or an old policy kept for reference is
// ignored and the first LIVE match wins. That first-match rule is safe because a
// browser enforces every delivered <meta> CSP simultaneously (the intersection),
// so a later meta can only tighten, never loosen, and validating the first can't
// miss a weakening. The .htaccess header below is the opposite: Apache's
// `Header set` replaces, so there the last directive wins.
const [cspMeta] = findTags(html, "meta", {
  "http-equiv": "Content-Security-Policy",
});
const metaCsp = cspMeta?.attrs.get("content");

// The header CSP: the `Header [always] set Content-Security-Policy "..."`
// directive in dist/.htaccess, read through tools/shared/htaccess-csp.mjs. It skips
// Apache comments and commented-out examples, reassembles a backslash-continued
// directive, requires the `Header set` form, takes the LAST live match (Apache's
// `Header set` replaces, so the browser is served the last of repeated headers),
// and ignores any directive inside a request-scoping container while flagging an
// unbalanced structure — or an unsupported CSP-touching Header form (append,
// edit, or a conditional set) that would serve a policy other than the single
// value read here — so we fail closed rather than trust a mis-read policy. This
// file carries several <FilesMatch> blocks, so the scope tracking is load-
// bearing: a CSP added inside one would be served for those requests only.
const { headerCsp, scopesUnbalanced, unsupportedHeaders } =
  readHeaderCsp(htaccess);

const policies = [
  { name: "index.html <meta> CSP", csp: metaCsp },
  { name: ".htaccess header CSP", csp: headerCsp },
];

// The JavaScript MIME type essences the browser executes as a classic script
// (the WHATWG MIME-sniffing set, including the legacy aliases). Compared against
// the type's essence with parameters stripped, exactly as the browser does.
const JS_MIME_ESSENCES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

// Whether the browser would execute an inline <script> with this type attribute
// value (and so whether it needs a CSP hash). Mirrors "prepare the script
// element": the browser strips leading/trailing whitespace, then runs the script
// when the type is absent or empty (classic), an ASCII case-insensitive "module",
// or a JavaScript MIME type essence match — the type/subtype with any parameters
// (e.g. "; charset=utf-8") ignored. Anything else is a data block that never
// executes (e.g. application/ld+json). An exact-string allowlist of
// "module"/"text-or-application/javascript" is narrower than this, so it would
// wave through an executable inline script it failed to recognise (a trailing
// space, a charset parameter, a legacy alias) as if it were inert data.
function isExecutableJs(rawType) {
  if (rawType === undefined) return true; // no type attribute → classic JS
  const type = rawType.trim();
  if (type === "") return true; // empty type → classic JS
  if (/^module$/i.test(type)) return true; // module script
  const essence = type.split(";")[0].trim().toLowerCase();
  return JS_MIME_ESSENCES.has(essence);
}

let failed = false;
if (scopesUnbalanced) {
  failed = true;
  console.error(
    "check-csp: dist/.htaccess has unbalanced scoping containers - can't tell which Content-Security-Policy is the global one",
  );
}
for (const line of unsupportedHeaders) {
  failed = true;
  console.error(
    "check-csp: dist/.htaccess has a CSP-touching Header directive this guard " +
      `can't validate (only an unconditional \`set "…"\` is supported):\n  ${line}`,
  );
}
for (const { name, csp } of policies) {
  if (!csp) {
    failed = true;
    console.error(`check-csp: no Content-Security-Policy found in ${name}`);
  }
}
if (failed) process.exit(1);

// Parse each policy to a directive map once, here, and reuse it for both the
// lock-step comparison and the script-src lookup below.
const parsedPolicies = policies.map(({ name, csp }) => ({
  name,
  directives: parseCsp(csp),
}));
const [metaDirectives, headerDirectives] = parsedPolicies.map(
  (p) => p.directives,
);

// The two policies must stay in lock-step: the header is the <meta> baseline
// plus the directives a meta CSP can't express. comparePolicies strips those
// header-only directives from both sides — so adding one to the <meta> too is
// not read as a mismatch — while still asserting the header actually carries
// them at their pinned values, and diffs the rest so loosening or dropping a
// directive in only one file is caught, not just a drifted script hash.
const { missingHeaderOnly, headerOnlyMismatches, diffs } = comparePolicies(
  metaDirectives,
  headerDirectives,
);
for (const name of missingHeaderOnly) {
  failed = true;
  console.error(
    `check-csp: the .htaccess header is missing the required directive: ${name}`,
  );
}
for (const mismatch of headerOnlyMismatches) {
  failed = true;
  console.error(
    `check-csp: a header-only directive drifted from its expected value: ${mismatch}`,
  );
}
if (diffs.length) {
  failed = true;
  console.error(
    "check-csp: the <meta> and .htaccess CSPs disagree (header-only " +
      "frame-ancestors/upgrade-insecure-requests excluded):",
  );
  for (const d of diffs) console.error(`  ${d}`);
}

// Fail closed if a <script> start tag failed to parse into an element. The
// quote-aware scanner drops a start tag with malformed attributes (an unbalanced
// quote makes its closing `>` unmatchable), which would otherwise let an inline
// script slip out of enumeration and ship with no hash — a fail-open direction
// for a guard whose whole job is to hash every inline script. The HTML validator
// in the gate already rejects such markup, but this keeps CSP coverage from
// hinging on that separate check. Both counts come from the shared scanner:
// countRawTextOpeners counts `<script` openers on the same body-skipping basis
// scriptElements parses them, so a `<script` literal inside a script body (a
// bundled string, another script's source) or a comment is not miscounted — the
// two agree except on a start tag that fails to parse, which is the divergence
// this fails closed on.
const scriptEls = scriptElements(html);
const openers = countRawTextOpeners(html, "script");
if (openers !== scriptEls.length) {
  failed = true;
  console.error(
    `check-csp: ${openers} <script> start tag(s) but ${scriptEls.length} parsed as elements - malformed markup may hide an unhashed inline script`,
  );
}

// Every inline <script> in the built markup (external scripts are covered by
// script-src 'self' and carry no inline body to hash), selected from the list
// already parsed above via the shared predicate.
const scripts = scriptEls.filter(isInlineScript);

// The script-src value set of each policy, from the maps parsed above. An inline
// script's hash is checked for membership here — in the directive that actually
// governs inline scripts — rather than as a bare substring anywhere in the policy
// string. A substring test would also pass on a hash left behind in a different
// directive (or a comment-like fragment) while script-src itself lost it, exactly
// the drift this guard exists to catch. A missing script-src yields an empty set,
// so any inline script correctly fails.
const scriptSrc = parsedPolicies.map(({ name, directives }) => ({
  name,
  values: directives.get("script-src") ?? new Set(),
}));

let inlineJsCount = 0;
for (const { attrs, body } of scripts) {
  // Non-JS data blocks (e.g. application/ld+json) are not executed and so are
  // not subject to script-src; only real inline scripts need a hash.
  if (!isExecutableJs(attrs.get("type"))) continue;

  inlineJsCount++;
  const hash = createHash("sha256").update(body, "utf8").digest("base64");
  const token = `'sha256-${hash}'`;
  for (const { name, values } of scriptSrc) {
    if (!values.has(token)) {
      failed = true;
      console.error(
        `check-csp: inline script not allowed by the ${name}.\n  expected token: ${token}`,
      );
    }
  }
}

// Floor assertion: the build always emits the anti-flash theme script inline, so
// matching zero inline JS scripts means the markup or the scanner above drifted
// and the loop verified nothing. Without this, the guard would print success and
// exit 0 as a silent no-op, letting an unhashed inline script ship (blocked at
// runtime by the CSP, reintroducing the theme flash). Fail loudly instead.
if (inlineJsCount === 0) {
  console.error(
    "check-csp: found no inline <script> to hash in dist/index.html - the\n" +
      "  markup or the scanner has drifted, so this guard verified nothing.\n" +
      "  Refusing to green-light an unchecked CSP.",
  );
  process.exit(1);
}

if (failed) process.exit(1);
console.log(
  "check-csp: the two CSPs are consistent and cover all inline scripts",
);

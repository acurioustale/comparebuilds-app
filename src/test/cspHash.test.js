import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// Guards the fragile, hand-maintained link in the security config: any inline
// <script> the build emits must be allowlisted in the production CSP
// (public/.htaccess) by its sha256 hash, because script-src forbids
// 'unsafe-inline'. Today that's just the anti-flash theme resolver in
// index.html, but the check covers every inline script so adding a second one
// without allowlisting it is caught too. Editing a script without recomputing
// its hash silently blocks it in production (reintroducing the theme flash) and
// nothing else in the gate would notice — this turns it into a loud failure.

const repoFile = (rel) =>
  fileURLToPath(new URL(`../../${rel}`, import.meta.url));

// sha256 of every inline <script> the browser would execute: no src (external
// scripts are covered by script-src 'self') and a JS type (a non-JS block such
// as application/ld+json is data, not executed, so it needs no hash). Mirrors
// acurioustale/tools/check-csp.mjs.
const inlineScriptHashes = (html) => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const hashes = [];
  for (const [, attrs, body] of scripts) {
    if (/\bsrc=/i.test(attrs)) continue;
    const type = (attrs.match(/\btype=["']([^"']*)["']/i) || [])[1];
    const isJs =
      !type ||
      /^(module|text\/javascript|application\/javascript)$/i.test(type);
    if (!isJs) continue;
    hashes.push(createHash("sha256").update(body, "utf8").digest("base64"));
  }
  return hashes;
};

// Every sha256-… token declared in the .htaccess CSP header.
const declaredHashes = () => {
  const htaccess = readFileSync(repoFile("public/.htaccess"), "utf8");
  return [...htaccess.matchAll(/'sha256-([A-Za-z0-9+/=]+)'/g)].map((m) => m[1]);
};

describe("CSP inline-script hash", () => {
  test("every inline script in index.html is allowlisted in the .htaccess CSP", () => {
    const html = readFileSync(repoFile("index.html"), "utf8");
    const computed = inlineScriptHashes(html);
    expect(
      computed.length,
      "expected at least one inline <script> in index.html",
    ).toBeGreaterThan(0);

    const declared = declaredHashes();
    for (const hash of computed) {
      expect(
        declared,
        `inline script sha256-${hash} missing from CSP`,
      ).toContain(hash);
    }
  });

  test("a non-JS inline block (application/ld+json) needs no hash", () => {
    // Regression guard for the type filter: a data block isn't executed, so it
    // must not be treated as a script that requires allowlisting.
    const html = `<script type="application/ld+json">{"@context":"x"}</script>`;
    expect(inlineScriptHashes(html)).toHaveLength(0);
  });

  test("a second, un-allowlisted inline script fails the check", () => {
    // The original test only matched the first inline <script>. Mirror the real
    // failure mode for the multi-script case: a second attribute-less inline
    // script whose hash isn't in the CSP must be flagged. Simulate it here
    // rather than mutating index.html.
    const html = readFileSync(repoFile("index.html"), "utf8");
    const withExtra = html.replace(
      "</head>",
      "<script>console.log('unlisted')</script></head>",
    );
    const declared = declaredHashes();
    const missing = inlineScriptHashes(withExtra).filter(
      (h) => !declared.includes(h),
    );
    expect(missing).toHaveLength(1);
  });
});

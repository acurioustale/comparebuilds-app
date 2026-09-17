import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCsp, directiveDiff, comparePolicies } from "./csp-directives.mjs";

// --- parseCsp ---------------------------------------------------------------

test("parseCsp maps each directive to its value set, lower-casing the name", () => {
  const d = parseCsp("Default-Src 'none'; script-src 'self' 'sha256-x'");
  assert.deepEqual([...d.keys()], ["default-src", "script-src"]);
  assert.deepEqual([...d.get("script-src")], ["'self'", "'sha256-x'"]);
});

test("parseCsp keeps the first of a repeated directive and ignores empty parts", () => {
  // A duplicate directive is honoured at its first occurrence by the browser, so
  // a drifted permissive copy must not be masked by a later restrictive one. A
  // trailing `;` yields an empty part that must be skipped, not throw.
  const d = parseCsp("script-src *; script-src 'self'; ");
  assert.deepEqual([...d.get("script-src")], ["*"]);
  assert.equal(d.size, 1);
});

// --- directiveDiff ----------------------------------------------------------

test("directiveDiff reports directives present in only one policy or differing", () => {
  const meta = parseCsp("default-src 'none'; img-src 'self'");
  const header = parseCsp("default-src 'none'; script-src 'self'");
  assert.deepEqual(directiveDiff(meta, header), [
    "img-src: only in <meta>",
    "script-src: only in .htaccess",
  ]);
});

test("directiveDiff flags a directive whose value sets differ", () => {
  const meta = parseCsp("script-src 'self'");
  const header = parseCsp("script-src 'self' 'sha256-x'");
  assert.deepEqual(directiveDiff(meta, header), [
    "script-src: <meta> ['self'] vs .htaccess ['self' 'sha256-x']",
  ]);
});

test("directiveDiff returns nothing when the two policies match", () => {
  const csp = "default-src 'none'; script-src 'self'";
  assert.deepEqual(directiveDiff(parseCsp(csp), parseCsp(csp)), []);
});

// --- comparePolicies --------------------------------------------------------

const META = "default-src 'none'; script-src 'self'; base-uri 'none'";
const HEADER = `${META}; frame-ancestors 'none'; upgrade-insecure-requests`;

// comparePolicies takes each policy already parsed to a directive map, so the
// caller parses once and reuses the maps.
const compare = (metaCsp, headerCsp) =>
  comparePolicies(parseCsp(metaCsp), parseCsp(headerCsp));

test("comparePolicies passes when the header is the meta plus header-only directives", () => {
  const { missingHeaderOnly, diffs } = compare(META, HEADER);
  assert.deepEqual(missingHeaderOnly, []);
  assert.deepEqual(diffs, []);
});

test("comparePolicies does not flag a header-only directive also present in the meta", () => {
  // Adding frame-ancestors to the <meta> too is harmless (the browser ignores it
  // there); it must not read as `only in <meta>` and fail the build.
  const meta = `${META}; frame-ancestors 'none'`;
  const { missingHeaderOnly, diffs } = compare(meta, HEADER);
  assert.deepEqual(missingHeaderOnly, []);
  assert.deepEqual(diffs, []);
});

test("comparePolicies reports a header missing a required header-only directive", () => {
  const header = `${META}; frame-ancestors 'none'`; // no upgrade-insecure-requests
  const { missingHeaderOnly } = compare(META, header);
  assert.deepEqual(missingHeaderOnly, ["upgrade-insecure-requests"]);
});

test("comparePolicies flags a header-only directive weakened to a permissive value", () => {
  // Present but weakened: `frame-ancestors *` still contains the directive, so a
  // presence-only check waved it through. Its value must match the pinned 'none'.
  const header = `${META}; frame-ancestors *; upgrade-insecure-requests`;
  const { missingHeaderOnly, headerOnlyMismatches, diffs } = compare(
    META,
    header,
  );
  assert.deepEqual(missingHeaderOnly, []);
  assert.deepEqual(diffs, []);
  assert.deepEqual(headerOnlyMismatches, [
    "frame-ancestors: expected ['none'] but .htaccess has [*]",
  ]);
});

test("comparePolicies passes the pinned header-only values with no mismatch", () => {
  const { headerOnlyMismatches } = compare(META, HEADER);
  assert.deepEqual(headerOnlyMismatches, []);
});

test("comparePolicies still catches a real divergence in a shared directive", () => {
  const header = `default-src 'none'; script-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; upgrade-insecure-requests`;
  const { diffs } = compare(META, header);
  assert.deepEqual(diffs, [
    "script-src: <meta> ['self'] vs .htaccess ['self' 'unsafe-inline']",
  ]);
});

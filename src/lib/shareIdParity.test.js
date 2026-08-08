import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The 8–16 char share-id format is a cross-stack contract: the SPA route resolver
// (route.js), the share API (api/share.php valid_share_id), and the OG image
// endpoint (api/og.php) must all accept exactly the same ids — otherwise a
// /s/<id> page, its preview image, and the in-app link can disagree. There's no
// shared module across JS and PHP, so this test pins the three copies together,
// mirroring limitsParity.test.js for the build limits.

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const routeJs = read("./route.js");
const sharePhp = read("../../api/share.php");
const ogPhp = read("../../api/og.php");

// The canonical pattern source: route.js's SHARE_ID_RE literal body.
const jsPattern = (() => {
  const m = routeJs.match(/SHARE_ID_RE\s*=\s*\/(.+?)\/;/);
  if (!m) throw new Error("could not find SHARE_ID_RE in route.js");
  return m[1];
})();

// Every share-id regex literal (a /^[A-Za-z0-9]…$/ in a preg_match call) in a
// PHP file, as {body, flags}. Deliberately anchored so it ignores BUILD_PATTERN
// and the like. Flags are captured because comparing bodies alone cannot see a
// behavioural divergence — see the trailing-newline test below.
const phpPatterns = (src) => {
  const out = [];
  const re =
    /(?:preg_match\(\s*|const\s+SHARE_ID_PATTERN\s*=\s*)'\/(\^\[A-Za-z0-9\][^']*\$)\/([a-zA-Z]*)'/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push({ body: m[1], flags: m[2] });
  return out;
};

// Every delimited PHP pattern constant, as {name, body, flags}. Used to hold the
// whole family to the same end-of-subject semantics, not just the share id.
const phpPatternConsts = (src) => {
  const out = [];
  const re = /const\s+(\w*PATTERN)\s*=\s*'\/(.+?)\/([a-zA-Z]*)';/g;
  let m;
  while ((m = re.exec(src)) !== null)
    out.push({ name: m[1], body: m[2], flags: m[3] });
  return out;
};

describe("share-id pattern parity across route.js, share.php, og.php", () => {
  test("route.js defines the 8–16 char alphanumeric id pattern", () => {
    expect(jsPattern).toBe("^[A-Za-z0-9]{8,16}$");
  });

  test("share.php's share-id regex matches route.js", () => {
    const found = phpPatterns(sharePhp);
    expect(found.length).toBeGreaterThan(0);
    for (const p of found) expect(p.body).toBe(jsPattern);
  });

  // Comparing pattern bodies is not enough to prove the two stacks agree: in
  // PCRE, `$` also matches immediately before a trailing newline unless the D
  // modifier is set, while JS `$` (without `m`) means end-of-input. Identical
  // bodies would therefore still accept different inputs — "abcdefgh\n" would
  // pass in PHP and fail in JS. Pin the modifier that closes that gap.
  test("share.php's share-id regex ends at end-of-subject (D modifier)", () => {
    // The JS side must not be in multiline mode, or `$` would match at any
    // line break and the D modifier could not restore parity.
    const routeFlags = routeJs.match(/SHARE_ID_RE\s*=\s*\/.+?\/(\w*);/)?.[1];
    expect(routeFlags).toBe("");

    const found = phpPatterns(sharePhp);
    expect(found.length).toBeGreaterThan(0);
    for (const p of found) expect(p.flags).toContain("D");
  });

  // The share id is not the only cross-stack pattern: a build string or layout
  // hash with a trailing newline must be rejected too, since the stored value
  // is echoed back to a JS client that will not tolerate it.
  test("every anchored pattern constant in share.php sets the D modifier", () => {
    const consts = phpPatternConsts(sharePhp);
    expect(consts.length).toBeGreaterThan(0);
    for (const c of consts) {
      if (!c.body.endsWith("$")) continue;
      expect(c.flags, `${c.name} must set the D modifier`).toContain("D");
    }
  });

  test("og.php delegates id validation to share.php's valid_share_id", () => {
    // og.php no longer carries its own copy of the pattern: it includes share.php
    // and calls valid_share_id, so there is a single PHP source of truth.
    expect(phpPatterns(ogPhp)).toHaveLength(0);
    expect(ogPhp).toMatch(/require_once\s+__DIR__\s*\.\s*['"]\/share\.php['"]/);
    expect(ogPhp).toMatch(/valid_share_id\(/);
  });

  test("share.php ID_LEN matches the validated id minimum length", () => {
    const m = sharePhp.match(/const\s+ID_LEN\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    // The generated id length must equal the {N,M} minimum repeat count.
    const repeat = jsPattern.match(/\{(\d+),(\d+)\}/);
    expect(repeat).not.toBeNull();
    expect(Number(m[1])).toBe(Number(repeat[1]));
  });

  test("share.php MAX_ID_LEN matches the validated id maximum length", () => {
    const m = sharePhp.match(/const\s+MAX_ID_LEN\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    // The longest id collision-extension can mint must equal the {N,M} maximum,
    // or store_share could produce an id valid_share_id/route.js/og.php reject.
    const repeat = jsPattern.match(/\{(\d+),(\d+)\}/);
    expect(repeat).not.toBeNull();
    expect(Number(m[1])).toBe(Number(repeat[2]));
  });
});

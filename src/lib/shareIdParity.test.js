import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The 6-char share-id format is a cross-stack contract: the SPA route resolver
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
// PHP file. Deliberately anchored so it ignores BUILD_PATTERN and the like.
const phpPatterns = (src) => {
  const out = [];
  const re = /preg_match\(\s*'\/(\^\[A-Za-z0-9\][^']*\$)\/'/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
};

describe("share-id pattern parity across route.js, share.php, og.php", () => {
  test("route.js defines the 6-char alphanumeric id pattern", () => {
    expect(jsPattern).toBe("^[A-Za-z0-9]{6}$");
  });

  test("share.php's share-id regex matches route.js", () => {
    const found = phpPatterns(sharePhp);
    expect(found.length).toBeGreaterThan(0);
    for (const p of found) expect(p).toBe(jsPattern);
  });

  test("og.php's share-id regex matches route.js", () => {
    const found = phpPatterns(ogPhp);
    expect(found.length).toBeGreaterThan(0);
    for (const p of found) expect(p).toBe(jsPattern);
  });

  test("share.php ID_LEN matches the validated id length", () => {
    const m = sharePhp.match(/const\s+ID_LEN\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    // The generated id length must equal the {N} repeat count in the pattern.
    const repeat = jsPattern.match(/\{(\d+)\}/);
    expect(repeat).not.toBeNull();
    expect(Number(m[1])).toBe(Number(repeat[1]));
  });
});

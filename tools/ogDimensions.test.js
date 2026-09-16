import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

import { declaredOgDimensions, pngDimensions } from "./og-dimensions.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

// --- declaredOgDimensions ---------------------------------------------------

test("declaredOgDimensions reads the width and height metas", () => {
  const html = `<meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />`;
  assert.deepEqual(declaredOgDimensions(html), { width: 1200, height: 630 });
});

test("declaredOgDimensions skips a meta inside an HTML comment", () => {
  // A previous size kept as a comment must not be read as the declaration.
  const html = `<!-- <meta property="og:image:width" content="800" /> -->
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />`;
  assert.deepEqual(declaredOgDimensions(html), { width: 1200, height: 630 });
});

test("declaredOgDimensions yields undefined for a missing or non-numeric meta", () => {
  // undefined, not NaN: the guard must be able to say "nothing to check
  // against" rather than silently compare a number to NaN and pass or fail by
  // accident.
  assert.deepEqual(declaredOgDimensions(""), {
    width: undefined,
    height: undefined,
  });
  const odd = `<meta property="og:image:width" content="1200px" />
    <meta property="og:image:height" content="" />`;
  assert.deepEqual(declaredOgDimensions(odd), {
    width: undefined,
    height: undefined,
  });
});

// --- pngDimensions ----------------------------------------------------------

test("pngDimensions reads the IHDR width and height", () => {
  const buf = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buf, 0);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(1200, 16);
  buf.writeUInt32BE(630, 20);
  assert.deepEqual(pngDimensions(buf), { width: 1200, height: 630 });
});

test("pngDimensions rejects a non-PNG and a PNG with no IHDR", () => {
  assert.throws(() => pngDimensions(Buffer.alloc(24)), /not a valid PNG/);
  const buf = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buf, 0);
  buf.write("IDAT", 12, "ascii");
  assert.throws(() => pngDimensions(buf), /missing IHDR/);
});

// --- the dynamic share card -------------------------------------------------

// api/og.php renders the per-share preview image and api/share.php writes the
// og:image:width/height metas that advertise it. They are two files in two
// languages describing one image, so nothing but a test stops them drifting —
// and a drifted pair means every shared link unfurls to a cropped or
// letterboxed card, which no other check in the gate would see. (The static
// card is the other pair: index.html's metas against public/og-image.png,
// bound by tools/check-og-image.mjs.)
describe("dynamic share-card dimension parity", () => {
  const ogPhp = read("../api/og.php");
  const sharePhp = read("../api/share.php");

  const phpVar = (name) => {
    const m = ogPhp.match(new RegExp(`\\$${name}\\s*=\\s*(\\d+)\\s*;`));
    if (!m) throw new Error(`could not find PHP variable $${name} in og.php`);
    return Number(m[1]);
  };

  // share.php emits the metas from PHP string concatenation, not markup a tag
  // scanner can read, so match the emitted literal.
  const emittedMeta = (property) => {
    const m = sharePhp.match(
      new RegExp(`og:image:${property}\\\\"\\s+content=\\\\"(\\d+)\\\\"`),
    );
    if (!m) {
      throw new Error(`could not find the emitted og:image:${property} meta`);
    }
    return Number(m[1]);
  };

  test("share.php advertises the width og.php renders", () => {
    expect(emittedMeta("width")).toBe(phpVar("W"));
  });

  test("share.php advertises the height og.php renders", () => {
    expect(emittedMeta("height")).toBe(phpVar("H"));
  });
});

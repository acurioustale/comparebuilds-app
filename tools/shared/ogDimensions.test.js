import { test } from "node:test";
import assert from "node:assert/strict";

import {
  declaredOgDimension,
  declaredOgDimensions,
  ogImagePath,
  pngDimensions,
} from "./og-dimensions.mjs";

// The og-image guard binds two surfaces that no other check compares: the size
// and path a page advertises to link unfurlers, and the PNG actually served. A
// reader that is subtly wrong here fails the way guard regexes have failed
// before — quietly, by validating the wrong file or comparing against NaN — so
// each reader is pinned on the inputs that make it interesting. The quoting and
// comment mechanics live in ./html-tags.mjs (htmlTags.test.js).

// --- declaredOgDimension ----------------------------------------------------

test("declaredOgDimension reports the parsed integer of a live meta", () => {
  const html = '<meta property="og:image:width" content="1200" />';
  assert.deepEqual(declaredOgDimension(html, "og:image:width"), {
    present: true,
    raw: "1200",
    value: 1200,
  });
});

test("declaredOgDimension tells a missing meta from an unreadable one", () => {
  // The distinction is the point: a dropped meta and a "1200px" are different
  // mistakes, and a guard that reports both as "no meta" sends the reader to
  // the wrong line. Both yield no value, so neither is ever compared as NaN.
  assert.deepEqual(declaredOgDimension("", "og:image:width"), {
    present: false,
    raw: undefined,
    value: undefined,
  });
  const odd = '<meta property="og:image:width" content="1200px" />';
  assert.deepEqual(declaredOgDimension(odd, "og:image:width"), {
    present: true,
    raw: "1200px",
    value: undefined,
  });
});

test("declaredOgDimension reads a valueless content attribute as empty", () => {
  // A meta whose content attribute is absent altogether is present-but-
  // unreadable, not missing — the tag is there to be fixed.
  const html = '<meta property="og:image:height" />';
  assert.deepEqual(declaredOgDimension(html, "og:image:height"), {
    present: true,
    raw: "",
    value: undefined,
  });
});

test("declaredOgDimension skips a meta inside an HTML comment", () => {
  // A previous size kept as a comment must not be read as the declaration.
  const html = `<!-- <meta property="og:image:width" content="800" /> -->
    <meta property="og:image:width" content="1200" />`;
  assert.equal(declaredOgDimension(html, "og:image:width").value, 1200);
});

// --- declaredOgDimensions ---------------------------------------------------

test("declaredOgDimensions reads the width and height metas as a pair", () => {
  const html = `<meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />`;
  assert.deepEqual(declaredOgDimensions(html), { width: 1200, height: 630 });
});

test("declaredOgDimensions yields undefined for a missing or odd meta", () => {
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

// --- ogImagePath ------------------------------------------------------------

test("ogImagePath takes the path out of the absolute og:image URL", () => {
  const html =
    '<meta property="og:image" content="https://example.test/assets/og-image.png" />';
  assert.equal(ogImagePath(html), "assets/og-image.png");
});

test("ogImagePath tolerates a relative og:image value", () => {
  const rooted = '<meta property="og:image" content="/assets/og-image.png" />';
  assert.equal(ogImagePath(rooted), "assets/og-image.png");
  const bare = '<meta property="og:image" content="assets/og-image.png" />';
  assert.equal(ogImagePath(bare), "assets/og-image.png");
});

test("ogImagePath yields undefined when no image is declared", () => {
  // Nothing to check: a guard must say so rather than fall back to a hardcoded
  // filename and report on a file the page no longer advertises.
  assert.equal(ogImagePath(""), undefined);
  assert.equal(
    ogImagePath('<meta property="og:image" content="" />'),
    undefined,
  );
});

test("ogImagePath ignores an og:image inside an HTML comment", () => {
  const html = `<!-- <meta property="og:image" content="/assets/old.png" /> -->
    <meta property="og:image" content="/assets/og-image.png" />`;
  assert.equal(ogImagePath(html), "assets/og-image.png");
});

// --- pngDimensions ----------------------------------------------------------

const pngHeader = (type, width, height) => {
  const buf = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buf, 0);
  buf.write(type, 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
};

test("pngDimensions reads the IHDR width and height", () => {
  assert.deepEqual(pngDimensions(pngHeader("IHDR", 1200, 630)), {
    width: 1200,
    height: 630,
  });
});

test("pngDimensions rejects a non-PNG and a PNG with no IHDR", () => {
  assert.throws(() => pngDimensions(Buffer.alloc(24)), /not a valid PNG/);
  assert.throws(
    () => pngDimensions(pngHeader("IDAT", 1200, 630)),
    /missing IHDR/,
  );
});

test("pngDimensions rejects a file too short to hold an IHDR", () => {
  // A truncated or empty file must report as "not a valid PNG", not read past
  // its end and compare against whatever readUInt32BE would throw on.
  assert.throws(
    () => pngDimensions(pngHeader("IHDR", 1200, 630).subarray(0, 23)),
    /not a valid PNG/,
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  declaredOrigins,
  localPath,
  dirOf,
  parseSrcset,
  cssUrls,
  htmlRefs,
  cssRefs,
  manifestRefs,
} from "./asset-refs.mjs";

// A neutral fixture origin: the bundle is mirrored byte-for-byte across repos,
// so no test here may name either site's real hostname.
const SITE = "https://example.test";
const origins = new Set([SITE]);

// --- declaredOrigins --------------------------------------------------------

test("declaredOrigins reads the site origin from canonical and og:url", () => {
  const found = declaredOrigins(`
    <link rel="canonical" href="${SITE}/" />
    <meta property="og:url" content="${SITE}/" />
  `);
  assert.deepEqual([...found], [SITE]);
});

test("declaredOrigins ignores a relative or missing value", () => {
  const found = declaredOrigins(`
    <link rel="canonical" href="/" />
    <link rel="canonical" />
    <meta property="og:url" content="" />
  `);
  assert.equal(found.size, 0);
});

// --- localPath --------------------------------------------------------------

test("localPath normalises relative, root-relative and ./ references", () => {
  assert.equal(localPath("assets/favicon.svg"), "assets/favicon.svg");
  assert.equal(localPath("/assets/favicon.svg"), "assets/favicon.svg");
  assert.equal(localPath("././assets/favicon.svg"), "assets/favicon.svg");
});

test("localPath strips a query and a fragment", () => {
  assert.equal(localPath("css/style.css?v=2"), "css/style.css");
  assert.equal(localPath("assets/favicon.svg#icon"), "assets/favicon.svg");
});

test("localPath resolves a relative reference against its base directory", () => {
  assert.equal(
    localPath("../assets/bg.png", { base: "css/" }),
    "css/../assets/bg.png",
  );
  assert.equal(localPath("bg.png", { base: "css/" }), "css/bg.png");
  // A root-relative path ignores the base: it comes from the web root.
  assert.equal(localPath("/assets/bg.png", { base: "css/" }), "assets/bg.png");
});

test("localPath accepts a same-origin absolute URL and rejects a foreign one", () => {
  assert.equal(
    localPath(`${SITE}/assets/og-image.png`, { origins }),
    "assets/og-image.png",
  );
  assert.equal(
    localPath("https://elsewhere.test/assets/og-image.png", { origins }),
    undefined,
  );
  assert.equal(
    localPath("//example.test/assets/og-image.png", { origins }),
    "assets/og-image.png",
  );
  assert.equal(localPath("mailto:nobody@example.test", { origins }), undefined);
  assert.equal(localPath("data:image/png;base64,AAAA", { origins }), undefined);
});

test("localPath rejects an unparseable URL rather than throwing", () => {
  assert.equal(localPath("https://[", { origins }), undefined);
});

test("localPath rejects what names no file", () => {
  assert.equal(localPath(undefined), undefined);
  assert.equal(localPath(""), undefined);
  assert.equal(localPath("   "), undefined);
  assert.equal(localPath("#main"), undefined);
  assert.equal(localPath("/"), undefined);
  assert.equal(localPath("assets/"), undefined);
});

test("localPath decodes percent escapes, keeping an invalid one verbatim", () => {
  assert.equal(localPath("assets/my%20icon.png"), "assets/my icon.png");
  assert.equal(localPath("assets/%E0%A4.png"), "assets/%E0%A4.png");
});

// --- dirOf ------------------------------------------------------------------

test("dirOf returns the directory with its slash, empty at the root", () => {
  assert.equal(dirOf("css/style.css"), "css/");
  assert.equal(dirOf("index.html"), "");
});

// --- parseSrcset ------------------------------------------------------------

test("parseSrcset reads candidates with and without descriptors", () => {
  assert.deepEqual(parseSrcset("a.png 1x, b.png 2x"), ["a.png", "b.png"]);
  assert.deepEqual(parseSrcset("a.png"), ["a.png"]);
  // Per the HTML srcset syntax a comma only separates candidates when the URL
  // does not swallow it: a run with no whitespace is ONE url, commas and all.
  assert.deepEqual(parseSrcset("a.png,b.png"), ["a.png,b.png"]);
  assert.deepEqual(parseSrcset("a.png, b.png"), ["a.png", "b.png"]);
  assert.deepEqual(parseSrcset("a.png 1x,, b.png"), ["a.png", "b.png"]);
  assert.deepEqual(parseSrcset("  a.png 480w ,  b.png 800w  "), [
    "a.png",
    "b.png",
  ]);
  assert.deepEqual(parseSrcset(""), []);
  assert.deepEqual(parseSrcset(" , "), []);
});

// --- cssUrls ----------------------------------------------------------------

test("cssUrls reads quoted and unquoted url() targets", () => {
  assert.deepEqual(
    cssUrls(`a{background:url("a.png")}b{background:url('b.png')}`),
    ["a.png", "b.png"],
  );
  assert.deepEqual(cssUrls("a{background:url( c.png )}"), ["c.png"]);
});

test("cssUrls ignores a commented-out rule", () => {
  assert.deepEqual(
    cssUrls("/* a{background:url(old.png)} */ b{color:red}"),
    [],
  );
});

test("cssUrls keeps a value with an unbalanced quote verbatim", () => {
  assert.deepEqual(cssUrls(`a{background:url("a.png)}`), [`"a.png`]);
});

// --- htmlRefs ---------------------------------------------------------------

const PAGE = `
  <link rel="canonical" href="${SITE}/" />
  <link rel="icon" href="assets/favicon.svg" />
  <link rel="preload" as="image" imagesrcset="assets/wide.png 1200w, assets/narrow.png 600w" />
  <link rel="me" href="https://elsewhere.test/example" />
  <script src="js/app.js" type="module"></script>
  <script>inline()</script>
  <meta property="og:image" content="${SITE}/assets/og-image.png" />
  <meta name="twitter:image" content="${SITE}/assets/og-image.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <img src="assets/shot.png" srcset="assets/shot.png 1x, assets/shot@2x.png 2x" />
  <video src="assets/clip.mp4" poster="assets/poster.png"></video>
  <audio src="assets/clip.mp3"></audio>
  <source srcset="assets/alt.png" />
  <a href="/somewhere/">a route, not an asset</a>
`;

test("htmlRefs collects every local reference and no foreign one", () => {
  const paths = htmlRefs(PAGE).map((r) => r.path);
  assert.deepEqual(paths.sort(), [
    "assets/alt.png",
    "assets/clip.mp3",
    "assets/clip.mp4",
    "assets/favicon.svg",
    "assets/narrow.png",
    "assets/og-image.png",
    "assets/og-image.png",
    "assets/poster.png",
    "assets/shot.png",
    "assets/shot.png",
    "assets/shot@2x.png",
    "assets/wide.png",
    "js/app.js",
  ]);
});

test("htmlRefs names the source of each reference", () => {
  const refs = htmlRefs(PAGE);
  const shareImage = refs.find((r) => r.where.includes("twitter:image"));
  assert.match(shareImage.where, /content="https:\/\/example\.test\//);
  const srcset = refs.find((r) => r.where.includes("<img srcset>"));
  assert.match(srcset.where, /assets\/shot/);
});

test("htmlRefs prefixes the location with the document label", () => {
  const refs = htmlRefs(`<link rel="icon" href="/assets/favicon.svg" />`);
  assert.equal(refs[0].where, `index.html <link href="/assets/favicon.svg">`);
  const labelled = htmlRefs(
    `<link rel="icon" href="/assets/favicon.svg" />`,
    new Set(),
    "mage/frost/index.html",
  );
  assert.equal(
    labelled[0].where,
    `mage/frost/index.html <link href="/assets/favicon.svg">`,
  );
});

test("htmlRefs takes the share image only when the origin is ours", () => {
  const foreign = `
    <link rel="canonical" href="https://elsewhere.test/" />
    <meta property="og:image" content="${SITE}/assets/og-image.png" />
  `;
  assert.deepEqual(htmlRefs(foreign), []);
});

test("htmlRefs covers every og:image spelling", () => {
  const page = `
    <link rel="canonical" href="${SITE}/" />
    <meta property="og:image:url" content="/assets/a.png" />
    <meta property="og:image:secure_url" content="/assets/b.png" />
  `;
  assert.deepEqual(
    htmlRefs(page).map((r) => r.path),
    ["assets/a.png", "assets/b.png"],
  );
});

// --- cssRefs ----------------------------------------------------------------

test("cssRefs resolves url() against the stylesheet's own directory", () => {
  const refs = cssRefs(
    `a{background:url(bg.png)}b{background:url(data:image/png;base64,AA)}`,
    "css/style.css",
  );
  assert.deepEqual(refs, [
    { path: "css/bg.png", where: "css/style.css url(bg.png)" },
  ]);
});

test("cssRefs keeps a same-origin absolute url()", () => {
  const refs = cssRefs(
    `a{background:url(${SITE}/assets/bg.png)}`,
    "css/style.css",
    origins,
  );
  assert.deepEqual(
    refs.map((r) => r.path),
    ["assets/bg.png"],
  );
});

// --- manifestRefs -----------------------------------------------------------

test("manifestRefs collects icon and screenshot sources", () => {
  const refs = manifestRefs(
    JSON.stringify({
      start_url: "/",
      icons: [{ src: "assets/icon-192.png" }, {}],
      screenshots: [{ src: `${SITE}/assets/shot.png` }],
    }),
    origins,
  );
  assert.deepEqual(
    refs.map((r) => r.path),
    ["assets/icon-192.png", "assets/shot.png"],
  );
  assert.match(refs[0].where, /manifest\.webmanifest icons src=/);
  assert.match(refs[1].where, /manifest\.webmanifest screenshots src=/);
});

test("manifestRefs prefixes the location with the manifest label", () => {
  const refs = manifestRefs(
    JSON.stringify({ icons: [{ src: "/icon.png" }] }),
    new Set(),
    "dist/manifest.webmanifest",
  );
  assert.equal(
    refs[0].where,
    `dist/manifest.webmanifest icons src="/icon.png"`,
  );
});

test("manifestRefs tolerates a manifest with neither list", () => {
  assert.deepEqual(manifestRefs("{}"), []);
});

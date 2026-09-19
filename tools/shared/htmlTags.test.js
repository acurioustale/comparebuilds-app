import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseAttrs,
  htmlTags,
  findTags,
  rawTextElements,
  countRawTextOpeners,
} from "./html-tags.mjs";

// --- parseAttrs -------------------------------------------------------------

test("parseAttrs reads double-, single- and unquoted values plus boolean attrs", () => {
  const attrs = parseAttrs(
    ` name="theme-color" data-scheme='light' charset=utf-8 defer`,
  );
  assert.equal(attrs.get("name"), "theme-color"); // double-quoted
  assert.equal(attrs.get("data-scheme"), "light"); // single-quoted
  assert.equal(attrs.get("charset"), "utf-8"); // unquoted
  assert.equal(attrs.get("defer"), ""); // boolean → ""
  assert.equal(attrs.size, 4);
});

test("parseAttrs lower-cases names, preserves value case, keeps : and - in names", () => {
  const attrs = parseAttrs(
    `PROPERTY="OG:Image" http-equiv="Content-Security-Policy"`,
  );
  assert.equal(attrs.get("property"), "OG:Image");
  assert.equal(attrs.get("http-equiv"), "Content-Security-Policy");
});

test("parseAttrs unwraps a value containing the other quote and newlines", () => {
  const attrs = parseAttrs(
    `content="default-src 'none';\n  script-src 'self'"`,
  );
  assert.equal(
    attrs.get("content"),
    "default-src 'none';\n  script-src 'self'",
  );
});

test("parseAttrs ignores the / of a self-closing tag", () => {
  const attrs = parseAttrs(` name="x" /`);
  assert.equal(attrs.get("name"), "x");
  assert.equal(attrs.has("/"), false);
  assert.equal(attrs.size, 1);
});

test("parseAttrs keeps an unterminated-quote value verbatim, not slicing it", () => {
  // A malformed value that opens a quote it never closes reaches the bare-run
  // branch; it must be preserved as-is, not unwrapped (which would drop its last
  // character and silently forge a plausible-looking value).
  assert.equal(parseAttrs(`type="module`).get("type"), `"module`);
  assert.equal(parseAttrs(`type='module`).get("type"), `'module`);
  // A lone quote is length 1 and must survive rather than collapse to "".
  assert.equal(parseAttrs(`x="`).get("x"), `"`);
});

test("parseAttrs keeps the first of a duplicated attribute, as the browser does", () => {
  // A repeated attribute name is dropped by the HTML parser after the first, so
  // the guards must judge a tag on the value the browser actually uses. Reading
  // the last would let `type="module" type="application/ld+json"` hide an
  // executable inline script from the CSP guard, or a duplicated `content` swap
  // the meta CSP the guard validates for the one the browser enforces.
  const script = parseAttrs(`type="module" type="application/ld+json"`);
  assert.equal(script.get("type"), "module");
  assert.equal(script.size, 1);

  const meta = parseAttrs(`content="strict" content="loose"`);
  assert.equal(meta.get("content"), "strict");
});

// --- htmlTags ---------------------------------------------------------------

test("htmlTags yields each tag as { raw, attrs } in document order", () => {
  const html = `<meta charset="utf-8"><meta name="theme-color" content="#111">`;
  const tags = [...htmlTags(html, "meta")];
  assert.equal(tags.length, 2);
  assert.equal(tags[0].attrs.get("charset"), "utf-8");
  assert.equal(tags[1].attrs.get("content"), "#111");
  assert.match(tags[1].raw, /theme-color/);
});

test("htmlTags ends a tag at a `>` inside a quoted value, and anchors the tag name to a boundary", () => {
  // A quoted span is bounded to its tag, so a `>` in a value ends the tag early
  // and the rest of it reads as attribute-less junk. That is the trade: bounded,
  // a `>` in a value costs one truncated tag and surfaces loudly as a missing
  // attribute; unbounded, a stray quote pairs with a quote in a later tag and
  // quietly swallows the span between them while the guard still exits 0. No
  // quoted value in this repo's markup contains a `>`. <metadata> is not a <meta>.
  const html = `<metadata name="x"><meta data-note="a>b" content="1200">`;
  const tags = [...htmlTags(html, "meta")];
  assert.equal(tags.length, 1);
  assert.equal(tags[0].raw, `<meta data-note="a>`);
  assert.equal(tags[0].attrs.get("data-note"), `"a`);
  assert.equal(tags[0].attrs.get("content"), undefined);
});

test("htmlTags treats a stray quote in an unquoted value as a literal, not a span", () => {
  // An unbalanced `"` (or `'`) inside an unquoted value must not open a quoted
  // span that hunts past the tag's own `>` and swallows the following tag; a
  // browser treats the stray quote as a literal char and sees two tags.
  const dq = [
    ...htmlTags(`<meta name=a content=12"00><meta name="b">`, "meta"),
  ];
  assert.equal(dq.length, 2);
  assert.equal(dq[0].attrs.get("content"), `12"00`);
  assert.equal(dq[1].attrs.get("name"), "b");

  const sq = [...htmlTags(`<meta name=a content=it's><meta name='b'>`, "meta")];
  assert.equal(sq.length, 2);
  assert.equal(sq[0].attrs.get("content"), "it's");
  assert.equal(sq[1].attrs.get("name"), "b");
});

test("htmlTags scans an unterminated start tag in linear time", () => {
  // The open-tag pattern's quote branches must be mutually exclusive: a quote is
  // either the start of a balanced span or a stray literal, never both. When they
  // overlap, every quote becomes a fork the engine can revisit, and a start tag
  // that never closes — a truncated file, an unterminated attribute — backtracks
  // exponentially: the guard hangs instead of failing closed. 40 quotes cost
  // microseconds here and seconds with an overlapping fallback, so the budget
  // below separates the two by orders of magnitude rather than measuring
  // performance. The count is deliberately not higher: `node --test` has no
  // default timeout and the regex blocks the event loop, so a fixture big enough
  // to be unambiguous is also big enough to hang the run instead of failing it.
  const truncated = `<meta ${'"a'.repeat(40)}`;
  const started = Date.now();
  assert.deepEqual([...htmlTags(truncated, "meta")], []);
  assert.ok(Date.now() - started < 1000);
});

test("htmlTags rejects a hyphenated custom element like <meta-data>", () => {
  // `-` is a word boundary, so a `\b` after the name wrongly accepted this; the
  // name must be followed by whitespace, `/` or `>` to count as a <meta>.
  const html = `<meta-data name="x"><meta name="theme-color" content="#111">`;
  const tags = [...htmlTags(html, "meta")];
  assert.equal(tags.length, 1);
  assert.equal(tags[0].attrs.get("content"), "#111");
});

test("htmlTags skips a tag inside an HTML comment", () => {
  const html =
    `<!-- <meta name="theme-color" content="#stale"> -->` +
    `<meta name="theme-color" content="#live">`;
  const tags = [...htmlTags(html, "meta")];
  assert.equal(tags.length, 1);
  assert.equal(tags[0].attrs.get("content"), "#live");
});

// --- findTags ---------------------------------------------------------------

test("findTags narrows to tags matching every query pair, case-insensitively", () => {
  const html =
    `<meta name="theme-color" content="#111">` +
    `<meta property="og:image" content="x">`;
  const [tag, ...rest] = [...findTags(html, "meta", { NAME: "Theme-Color" })];
  assert.equal(rest.length, 0);
  assert.equal(tag.attrs.get("content"), "#111");
});

test("findTags rejects a tag missing a queried attribute", () => {
  const html = `<meta name="theme-color" content="#111">`;
  assert.deepEqual([...findTags(html, "meta", { property: "og:image" })], []);
});

test("findTags with no query yields every tag", () => {
  const html = `<meta charset="utf-8"><meta name="x">`;
  assert.equal([...findTags(html, "meta")].length, 2);
});

// --- rawTextElements --------------------------------------------------------

test("rawTextElements yields { raw, attrs, body } for a script element", () => {
  const html = `<script type="module" src="a.js">let x = 1;</script>`;
  const [el, ...rest] = [...rawTextElements(html, "script")];
  assert.equal(rest.length, 0);
  assert.equal(el.attrs.get("type"), "module");
  assert.equal(el.attrs.get("src"), "a.js");
  assert.equal(el.body, "let x = 1;");
});

test("rawTextElements tolerates close-tag junk and ignores </scriptx>", () => {
  const [el] = [...rawTextElements("<script>a</scriptx>b</script >", "script")];
  assert.equal(el.body, "a</scriptx>b");
});

test("rawTextElements does not treat </script-oops> as a close", () => {
  // A trailing name char (a hyphen here) keeps the element open in a browser, so
  // the body runs on to the real </script>; closing early would hash the wrong
  // bytes.
  const [el] = [
    ...rawTextElements("<script>a</script-oops>b</script>", "script"),
  ];
  assert.equal(el.body, "a</script-oops>b");
});

test("rawTextElements skips an element inside an HTML comment", () => {
  // A commented-out `<script>` never executes, so it must not be enumerated: the
  // CSP guard would otherwise demand a hash for dead markup, and its count check
  // (which steps over comments whole) would report a bogus divergence.
  const html = `<!-- <script>stale()</script> -->` + `<script>live()</script>`;
  const els = [...rawTextElements(html, "script")];
  assert.equal(els.length, 1);
  assert.equal(els[0].body, "live()");
  assert.equal(countRawTextOpeners(html, "script"), 1);
});

// --- countRawTextOpeners ----------------------------------------------------

test("countRawTextOpeners counts each opener once, skipping bodies", () => {
  // The `<script>` literal inside the first element's body is not its own opener
  // (the body scan swallows it), so the count is 2, not 3 — a raw /<script/g would
  // over-count here and false-alarm the CSP guard on valid markup.
  const html =
    `<script type="application/ld+json">{"x":"<script>"}</script>` +
    `<script>ok()</script>`;
  assert.equal(countRawTextOpeners(html, "script"), 2);
});

test("countRawTextOpeners still counts an opener the element scan can't close", () => {
  // A `<script>` with no `</script>` is a real opener but forms no element, so the
  // count exceeds the parsed elements — the divergence the CSP guard fails closed
  // on, catching an inline script that would slip out of enumeration unhashed.
  const html = `<script>hidden()`;
  assert.equal(countRawTextOpeners(html, "script"), 1);
  assert.equal([...rawTextElements(html, "script")].length, 0);
});

test("countRawTextOpeners counts an unclosed opener and stops at end of input", () => {
  assert.equal(countRawTextOpeners("<script>never closed", "script"), 1);
});

test("countRawTextOpeners returns 0 when there is no opener", () => {
  assert.equal(countRawTextOpeners("<p>hi</p>", "script"), 0);
});

test("countRawTextOpeners ignores a <script literal in another tag's attribute value", () => {
  // A `<script` inside a `<meta content="…">` value (here after the last real
  // script, so no body scan swallows it) must not be counted as its own opener,
  // or the CSP guard false-alarms "malformed markup" on valid markup.
  const html = `<script src="a.js"></script><meta content="try a <script tag">`;
  assert.equal(countRawTextOpeners(html, "script"), 1);
  assert.equal([...rawTextElements(html, "script")].length, 1);
});

test("countRawTextOpeners ignores a <script literal inside an HTML comment", () => {
  const html = `<script>ok()</script><!-- <script> keep for reference -->`;
  assert.equal(countRawTextOpeners(html, "script"), 1);
});

test("countRawTextOpeners still counts an unclosed opener with attributes", () => {
  // A start tag with no `>` (and so no `</script>`) forms no element but is a
  // real opener — the fail-closed divergence the CSP guard exists to catch.
  const html = `<script src="a.js"`;
  assert.equal(countRawTextOpeners(html, "script"), 1);
  assert.equal([...rawTextElements(html, "script")].length, 0);
});

test("countRawTextOpeners walks past a stray < that starts no tag", () => {
  assert.equal(countRawTextOpeners("a < b <script>x()</script>", "script"), 1);
});

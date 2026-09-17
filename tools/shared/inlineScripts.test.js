import { test } from "node:test";
import assert from "node:assert/strict";

import { scriptElements, inlineScripts } from "./inline-scripts.mjs";

// The CSP guard trusts this extractor to see every inline <script>: one it skips
// ships unhashed and would slip past the guard. So the end-tag match must accept
// every form a browser treats as a close, and a real `src` must be told apart
// from a `src` that only looks like one. The quote/close-tag mechanics live in
// ./html-tags.mjs (htmlTags.test.js); these tests cover the script
// selection built on it: attrs as a parsed Map, and the inline/external split.

test("scriptElements yields { attrs, body } with parsed attributes", () => {
  const [el, ...rest] = scriptElements('<script type="module">x=1</script>');
  assert.equal(rest.length, 0);
  assert.equal(el.body, "x=1");
  assert.equal(el.attrs.get("type"), "module");
});

test("matches end tags carrying whitespace or junk before the close", () => {
  // Every one of these is a valid close per the HTML tokenizer; a bare
  // `</script>` pattern would miss them and skip the element.
  for (const end of [
    "</script>",
    "</script >",
    "</script/>",
    "</script\n x>",
  ]) {
    const [el] = scriptElements(
      `<script>body</script>`.replace("</script>", end),
    );
    assert.equal(el?.body, "body", `end tag ${JSON.stringify(end)}`);
  }
});

test("does not treat a different tag like </scriptx> as a close", () => {
  const [el] = scriptElements("<script>a</scriptx>b</script>");
  assert.equal(el.body, "a</scriptx>b");
});

test("inlineScripts drops elements with a src attribute", () => {
  const scripts = inlineScripts(
    '<script src="a.js"></script><script>inline</script>',
  );
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].body, "inline");
});

test("inlineScripts keeps an inline script whose attr merely ends in -src", () => {
  // `data-src` / `x-src` are not the `src` attribute; treating them as external
  // would skip hashing their inline body.
  for (const attr of ["data-src", "x-src"]) {
    const scripts = inlineScripts(`<script ${attr}="a.js">inline</script>`);
    assert.equal(scripts.length, 1, `attr ${attr}`);
    assert.equal(scripts[0].body, "inline");
    assert.equal(scripts[0].attrs.get(attr), "a.js");
  }
});

test("inlineScripts still drops a real src attribute with spaces around =", () => {
  const scripts = inlineScripts(
    '<script src = "a.js"></script><script>inline</script>',
  );
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].body, "inline");
});

test("inlineScripts keeps a script whose value merely contains a src= substring", () => {
  // A ` src=` inside another attribute's quoted value must not be read as a real
  // src attribute; otherwise this genuine inline script is dropped and its body
  // ships unhashed. Both quote styles are handled by the parser.
  for (const attrs of ['data-tpl="<img src=x"', "data-tpl='<img src=y'"]) {
    const scripts = inlineScripts(`<script ${attrs}>inline</script>`);
    assert.equal(scripts.length, 1, `attrs ${attrs}`);
    assert.equal(scripts[0].body, "inline");
  }
});

test("inlineScripts treats a valueless src attribute as external", () => {
  // `<script src>` (no value) fetches the current page rather than executing an
  // inline body, so it counts as external — the same result as `src=""`.
  const scripts = inlineScripts("<script src></script><script>inline</script>");
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].body, "inline");
});

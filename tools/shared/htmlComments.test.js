import { test } from "node:test";
import assert from "node:assert/strict";
import { isCommented } from "./html-comments.mjs";

// The index of the `X` marker in each fixture, so the assertions read by intent.
const at = (html) => html.indexOf("X");

test("isCommented is true for a position inside a comment span", () => {
  const html = `a <!-- X --> b`;
  assert.equal(isCommented(html, at(html)), true);
});

test("isCommented is false for a position after a comment closes", () => {
  const html = `<!-- note --> X`;
  assert.equal(isCommented(html, at(html)), false);
});

test("isCommented is false for a position before any comment", () => {
  // The tag precedes the comment, so the scan breaks on the first later span
  // without ever containing the index.
  const html = `X <!-- later -->`;
  assert.equal(isCommented(html, at(html)), false);
});

test("isCommented is false when there are no comments", () => {
  const html = `plain X markup`;
  assert.equal(isCommented(html, at(html)), false);
});

test("isCommented is not fooled by a lone <!-- literal with no close", () => {
  // The bug the scan fixes: a `<!--` in content (here a script/attribute value)
  // with no matching `-->` must not swallow the live tag that follows it.
  const html = `<script>const s = "<!--";</script> X`;
  assert.equal(isCommented(html, at(html)), false);
});

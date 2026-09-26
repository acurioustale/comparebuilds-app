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

test("isCommented ignores a <!-- inside an attribute value", () => {
  // A plain `<!--…-->` match paired the literal in the value with the real
  // comment's `-->` and read every live tag between them as commented out.
  const html = `<meta content="a <!-- b"> X <!-- real -->`;
  assert.equal(isCommented(html, at(html)), false);
});

test("isCommented ignores a <!-- inside a script body", () => {
  const html = `<script>s = "<!--";</script> X <!-- real -->`;
  assert.equal(isCommented(html, at(html)), false);
});

test("isCommented is false for a position inside a text element's body", () => {
  const html = `<title>a <!-- X</title> <!-- real -->`;
  assert.equal(isCommented(html, at(html)), false);
});

test("isCommented is false inside a text element that never closes", () => {
  const html = `<script>s = "<!--"; X --> `;
  assert.equal(isCommented(html, at(html)), false);
});

test("isCommented is false for a position inside a tag", () => {
  const html = `<!-- a --><meta content="X">`;
  assert.equal(isCommented(html, at(html)), false);
});

test("isCommented steps over close tags, a doctype and stray <", () => {
  const html = `<!DOCTYPE html><p>1 < 2</p> <!-- X -->`;
  assert.equal(isCommented(html, at(html)), true);
});

test("isCommented is false at a stray < itself", () => {
  const html = `1 < 2`;
  assert.equal(isCommented(html, html.indexOf("<")), false);
});

test("isCommented is true for a tag inside a real comment", () => {
  const html = `<!-- <meta name="X"> --> <meta name="live">`;
  assert.equal(isCommented(html, html.indexOf("<meta")), true);
});

test("isCommented ends a comment where the tokenizer does, not only at -->", () => {
  // `--!>` ends a comment, and `<!-->` and `<!--->` are empty comments that
  // close at once, so the X after each is live markup.
  for (const html of [
    `<!-- a --!> X <!-- b -->`,
    `<!--> X <!-- b -->`,
    `<!---> X <!-- b -->`,
  ]) {
    assert.equal(isCommented(html, at(html)), false, html);
  }
  const html = `<!-- a --!> <!-- X --!>`;
  assert.equal(isCommented(html, at(html)), true);
});

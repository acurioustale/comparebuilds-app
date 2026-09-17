import { test } from "node:test";
import assert from "node:assert/strict";
import { lightDarkTokens } from "./css-tokens.mjs";

test("lightDarkTokens maps each light-dark() token to its lower-cased pair", () => {
  const css = `
    :root {
      --page-bg: light-dark(#E8E6DF, #0e0f10);
      --accent: light-dark( #Fff , #000 );
    }
  `;
  const tokens = lightDarkTokens(css);
  assert.deepEqual(tokens.get("page-bg"), {
    light: "#e8e6df",
    dark: "#0e0f10",
  });
  assert.deepEqual(tokens.get("accent"), { light: "#fff", dark: "#000" });
});

test("lightDarkTokens parses a declaration with whitespace before the colon", () => {
  // CSS allows `--x : value`. Such a token must still be parsed, not silently
  // dropped from the map — the drift guards would otherwise stop checking it.
  const tokens = lightDarkTokens("--page-bg : light-dark(#e8e6df, #0e0f10);");
  assert.deepEqual(tokens.get("page-bg"), {
    light: "#e8e6df",
    dark: "#0e0f10",
  });
});

test("lightDarkTokens still hard-fails a spaced unparseable declaration", () => {
  // The space-before-colon tolerance must not create a new silent-skip hole:
  // a spaced declaration with an unparseable value is still caught.
  assert.throws(
    () => lightDarkTokens("--accent : light-dark(white, black);"),
    /--accent/,
  );
});

test("lightDarkTokens parses functional colour notations", () => {
  // A translucent palette entry can't be written as hex without losing the
  // channel syntax, so both the space/slash and the legacy comma form parse.
  // Internal whitespace is collapsed so two spellings of one colour compare
  // equal; the value is otherwise kept verbatim.
  const tokens = lightDarkTokens(
    "--panel: light-dark(RGB(255  250 238 / 92%), rgba(10, 8, 4, 0.88));" +
      "--ink: light-dark(oklch(0.2 0 0), #fff);",
  );
  assert.deepEqual(tokens.get("panel"), {
    light: "rgb(255 250 238 / 92%)",
    dark: "rgba(10, 8, 4, 0.88)",
  });
  assert.deepEqual(tokens.get("ink"), {
    light: "oklch(0.2 0 0)",
    dark: "#fff",
  });
});

test("lightDarkTokens throws on a function that is not a colour notation", () => {
  // `var()` and a nested `color-mix()` are not colours this resolves. Accepting
  // them would hand a guard a string that is not the painted colour, so the
  // function names are an explicit list and anything else fails loudly.
  for (const value of [
    "light-dark(var(--a), var(--b))",
    "light-dark(color-mix(in srgb, #fff 50%, #000), #111)",
  ]) {
    assert.throws(() => lightDarkTokens(`--accent: ${value};`), /--accent/);
  }
});

test("lightDarkTokens ignores non light-dark() custom properties", () => {
  const tokens = lightDarkTokens("--plain: #123456; --page-bg: #abcdef;");
  assert.equal(tokens.size, 0);
});

test("lightDarkTokens ignores light-dark() tokens inside CSS comments", () => {
  // A commented-out palette line must not be parsed into the map (a phantom
  // token the drift guards would then compare against) nor tripped over by the
  // completeness check (a commented unparseable value must not hard-fail the
  // build).
  const css = `
    /* old: --page-bg: light-dark(oldwhite, oldblack); */
    --page-bg: light-dark(#e8e6df, #0e0f10);
    /* --accent: light-dark(#111, #222); */
  `;
  const tokens = lightDarkTokens(css);
  assert.deepEqual(tokens.get("page-bg"), {
    light: "#e8e6df",
    dark: "#0e0f10",
  });
  assert.equal(tokens.has("accent"), false);
  assert.equal(tokens.size, 1);
});

test("lightDarkTokens throws on a light-dark() token it can't parse", () => {
  // A bare keyword would otherwise be dropped silently, and the drift guards
  // that read the map would stop checking that token. It must be a loud
  // failure, not a quiet skip.
  for (const value of ["light-dark(white, black)", "light-dark(white, #fff)"]) {
    assert.throws(() => lightDarkTokens(`--accent: ${value};`), /--accent/);
  }
});

test("lightDarkTokens uses the last declaration when a token is redeclared", () => {
  // A later declaration wins in the CSS cascade, so the map must report the last
  // one (what the browser renders), not the first.
  const tokens = lightDarkTokens(
    "--x: light-dark(#111, #222); --x: light-dark(#333, #444);",
  );
  assert.deepEqual(tokens.get("x"), { light: "#333", dark: "#444" });
});

test("lightDarkTokens throws on an unparseable redeclaration of a parsed token", () => {
  // The hole this guards: a valid first declaration must not suppress the
  // completeness error for a later unparseable one. Otherwise the map keeps the
  // superseded value while the cascade uses the unparsed colour, and the palette
  // drift guards silently validate against a colour the page dropped.
  assert.throws(
    () =>
      lightDarkTokens(
        "--accent: light-dark(#111, #222); --accent: light-dark(red, blue);",
      ),
    /--accent/,
  );
});

test("lightDarkTokens throws on an unparseable token even when a later token parses", () => {
  // The offending token is named, and a parseable declaration further down
  // doesn't mask an earlier unparseable one.
  assert.throws(
    () =>
      lightDarkTokens(
        "--a: light-dark(red, blue); --b: light-dark(#111, #222);",
      ),
    /--a/,
  );
});

test("lightDarkTokens rejects hex colours of an invalid length", () => {
  // 5- and 7-digit hex are not valid CSS lengths (only 3/4/6/8). A dropped or
  // extra digit is a typo that must fail loudly, not parse as the token's value.
  for (const value of [
    "light-dark(#12345, #222)",
    "light-dark(#111, #1234567)",
  ]) {
    assert.throws(() => lightDarkTokens(`--accent: ${value};`), /--accent/);
  }
  // 4- and 8-digit hex (with alpha) stay valid.
  const tokens = lightDarkTokens("--x: light-dark(#abcd, #11223344);");
  assert.deepEqual(tokens.get("x"), { light: "#abcd", dark: "#11223344" });
});

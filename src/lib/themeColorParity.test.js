import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lightDarkTokens } from "../../tools/shared/css-tokens.mjs";
import { findTags } from "../../tools/shared/html-tags.mjs";

// The browser-chrome tint is set by two <meta name="theme-color"> tags, one per
// prefers-color-scheme, and must match the page background the CSS actually
// paints — otherwise the address-bar colour and the page disagree, and nothing
// else in the gate would notice the two drifting apart. The CSS background is a
// single `--wow-bg: light-dark(<light>, <dark>)` token, so this reads both
// values from one place and asserts each theme-color meta equals the matching
// side. Both parsing rules come from the mirrored tools/shared/ bundle rather
// than from regexes written here — see the CSP guard's note in CLAUDE.md.
// Mirrors acurioustale's test/themeColor.test.js, and follows the file-reading
// parity convention of shareIdParity/limitsParity.

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const html = read("../../index.html");
const wowBg = lightDarkTokens(read("../index.css")).get("wow-bg");

// Every <meta name="theme-color" …> tag, with the scheme its media query names.
// Attribute order varies, so findTags finds the tags by name and each tag's
// media/content are read off the parsed attributes.
function themeColorMetas() {
  return [...findTags(html, "meta", { name: "theme-color" })].map(
    ({ attrs }) => ({
      content: attrs.get("content") ?? null,
      scheme:
        attrs
          .get("media")
          ?.match(/prefers-color-scheme:\s*(light|dark)/)?.[1] ?? null,
    }),
  );
}

const contentForScheme = (scheme) =>
  themeColorMetas().find((m) => m.scheme === scheme)?.content ?? null;

describe("theme-color meta ↔ CSS --wow-bg parity", () => {
  test("the CSS exposes a --wow-bg light-dark() token", () => {
    expect(wowBg).toBeDefined();
  });

  test("index.html declares exactly two theme-color metas, one per scheme", () => {
    const metas = themeColorMetas();
    expect(metas).toHaveLength(2);
    expect(metas.map((m) => m.scheme).sort()).toEqual(["dark", "light"]);
  });

  test("the light theme-color meta matches the CSS light background", () => {
    expect(contentForScheme("light")?.toLowerCase()).toBe(wowBg.light);
  });

  test("the dark theme-color meta matches the CSS dark background", () => {
    expect(contentForScheme("dark")?.toLowerCase()).toBe(wowBg.dark);
  });
});

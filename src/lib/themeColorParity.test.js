import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The browser-chrome tint is set by two <meta name="theme-color"> tags, one per
// prefers-color-scheme, and must match the page background the CSS actually
// paints — otherwise the address-bar colour and the page disagree, and nothing
// else in the gate would notice the two drifting apart. The CSS background is a
// single `--wow-bg: light-dark(<light>, <dark>)` token, so this reads both
// values from one place and asserts each theme-color meta equals the matching
// side. Mirrors acurioustale's test/themeColor.test.js, and follows the
// file-reading parity convention of shareIdParity/limitsParity.

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const html = read("../../index.html");
const css = read("../index.css");

// --wow-bg: light-dark(<light>, <dark>);
const wowBg = css.match(
  /--wow-bg:\s*light-dark\(\s*(#[0-9a-fA-F]{3,8})\s*,\s*(#[0-9a-fA-F]{3,8})\s*\)/,
);

// Every <meta name="theme-color" …> tag in index.html. Attribute order varies,
// so capture content and media independently per tag.
function themeColorMetas() {
  const re = /<meta\b[^>]*\bname=["']theme-color["'][^>]*>/gi;
  return [...html.matchAll(re)].map(([tag]) => ({
    content: tag.match(/content=["'](#[0-9a-fA-F]{3,8})["']/)?.[1] ?? null,
    media: tag.match(/media=["']([^"']*)["']/)?.[1] ?? null,
  }));
}

function contentForScheme(scheme) {
  const meta = themeColorMetas().find((m) =>
    new RegExp(`prefers-color-scheme:\\s*${scheme}`).test(m.media ?? ""),
  );
  return meta?.content ?? null;
}

describe("theme-color meta ↔ CSS --wow-bg parity", () => {
  test("the CSS exposes a --wow-bg light-dark() token", () => {
    expect(wowBg).not.toBeNull();
  });

  test("index.html declares exactly two theme-color metas, one per scheme", () => {
    const metas = themeColorMetas();
    expect(metas).toHaveLength(2);
    const schemes = metas
      .map((m) => m.media?.match(/prefers-color-scheme:\s*(light|dark)/)?.[1])
      .sort();
    expect(schemes).toEqual(["dark", "light"]);
  });

  test("the light theme-color meta matches the CSS light background", () => {
    expect(contentForScheme("light")?.toLowerCase()).toBe(
      wowBg[1].toLowerCase(),
    );
  });

  test("the dark theme-color meta matches the CSS dark background", () => {
    expect(contentForScheme("dark")?.toLowerCase()).toBe(
      wowBg[2].toLowerCase(),
    );
  });
});

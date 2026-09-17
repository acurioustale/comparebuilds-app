import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lightDarkTokens } from "../../tools/shared/css-tokens.mjs";

// The web app manifest's background_color and theme_color drive the installed
// app's splash screen and OS chrome. A manifest carries a single colour — it
// can't express both schemes — and ours holds the DARK side of the page
// background (#0d0d14, the app's default look; the light palette is the
// opt-in), so both are bound to the dark value of the one `--wow-bg` token the
// page actually paints. Without this, the installed-app chrome could drift from
// the site with nothing in the gate to notice. Same shape as the theme-color
// binding in themeColorParity.test.js, on the same shared CSS helper.

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const wowBg = lightDarkTokens(read("../index.css")).get("wow-bg");
const manifest = JSON.parse(read("../../public/manifest.webmanifest"));

describe("manifest colours ↔ CSS --wow-bg parity", () => {
  test("the CSS exposes a --wow-bg light-dark() token", () => {
    expect(wowBg).toBeDefined();
  });

  test("the manifest background_color matches the CSS dark background", () => {
    expect(manifest.background_color?.toLowerCase()).toBe(wowBg.dark);
  });

  test("the manifest theme_color matches the CSS dark background", () => {
    expect(manifest.theme_color?.toLowerCase()).toBe(wowBg.dark);
  });
});

import { describe, test, expect } from "vitest";
import {
  THEMES,
  MODES,
  THEME_STORAGE_KEY,
  normalizeStoredMode,
  resolveMode,
  resolveTheme,
  nextMode,
} from "./theme.js";

describe("normalizeStoredMode", () => {
  test("honours the three explicit modes", () => {
    expect(normalizeStoredMode("auto")).toBe("auto");
    expect(normalizeStoredMode("light")).toBe("light");
    expect(normalizeStoredMode("dark")).toBe("dark");
  });

  test("treats anything else as no stored mode", () => {
    for (const v of [
      null,
      undefined,
      "",
      "Light",
      "system",
      "DARK",
      "Auto",
      "sepia",
      0,
    ]) {
      expect(normalizeStoredMode(v)).toBeNull();
    }
  });
});

describe("resolveMode", () => {
  test("returns the stored mode when valid", () => {
    expect(resolveMode("auto")).toBe("auto");
    expect(resolveMode("light")).toBe("light");
    expect(resolveMode("dark")).toBe("dark");
  });

  test("defaults to auto when nothing valid is stored", () => {
    expect(resolveMode(null)).toBe("auto");
    expect(resolveMode("garbage")).toBe("auto");
  });
});

describe("resolveTheme", () => {
  test("explicit light/dark modes paint themselves regardless of the OS", () => {
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  test("auto follows the OS preference", () => {
    expect(resolveTheme("auto", true)).toBe("light");
    expect(resolveTheme("auto", false)).toBe("dark");
  });
});

describe("nextMode", () => {
  test("on a light OS, the matching 'light' is visited last", () => {
    // Order auto → dark → light → (wrap) auto. Every step flips the painted
    // colour except the wrap auto→… ; the colour-neutral step is light→auto.
    expect(nextMode("auto", true)).toBe("dark");
    expect(nextMode("dark", true)).toBe("light");
    expect(nextMode("light", true)).toBe("auto");
  });

  test("on a dark OS, the matching 'dark' is visited last", () => {
    // Order auto → light → dark → (wrap) auto; neutral step is dark→auto.
    expect(nextMode("auto", false)).toBe("light");
    expect(nextMode("light", false)).toBe("dark");
    expect(nextMode("dark", false)).toBe("auto");
  });

  test("only the wrap back to auto is colour-neutral; the rest flip", () => {
    // Walk a full cycle from the default and confirm the painted colour flips on
    // every click except the one that lands on auto.
    for (const osLight of [true, false]) {
      let mode = "auto";
      const seen = new Set([mode]);
      let neutralSteps = 0;
      for (let i = 0; i < MODES.length; i++) {
        const prevColour = resolveTheme(mode, osLight);
        const nxt = nextMode(mode, osLight);
        if (resolveTheme(nxt, osLight) === prevColour) {
          neutralSteps++;
          expect(nxt).toBe("auto"); // the one neutral step is the wrap to auto
        }
        mode = nxt;
        seen.add(mode);
      }
      expect(neutralSteps).toBe(1); // exactly one dead step per full cycle
      expect(mode).toBe("auto"); // a full cycle returns to the start
      expect(seen).toEqual(new Set(MODES)); // all three states are reachable
    }
  });

  test("an unknown current mode falls back to the first cycle step", () => {
    expect(nextMode("sepia", true)).toBe("auto");
    expect(nextMode("sepia", false)).toBe("auto");
  });
});

describe("constants", () => {
  test("expose the resolved themes", () => {
    expect(THEMES).toEqual(["dark", "light"]);
  });

  test("expose the three cycle modes", () => {
    expect(MODES).toEqual(["auto", "light", "dark"]);
    expect(typeof THEME_STORAGE_KEY).toBe("string");
  });
});

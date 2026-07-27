import { describe, test, expect } from "vitest";
import { classIconSlug, iconUrl, onIconError } from "./iconUrl.js";

// The transparent 1x1 gif the helpers fall back to. Recovered via iconUrl(null)
// rather than duplicating the literal, so the test tracks the source of truth.
const BLANK = iconUrl(null);

describe("iconUrl", () => {
  test("builds a same-origin, lowercased /talent-icons path", () => {
    expect(iconUrl("Ability_Foo")).toBe("/talent-icons/ability_foo.jpg");
  });

  test("falls back to the blank pixel for a missing icon name", () => {
    expect(iconUrl("")).toBe(BLANK);
    expect(iconUrl(null)).toBe(BLANK);
    expect(iconUrl(undefined)).toBe(BLANK);
    expect(BLANK.startsWith("data:image/gif;base64,")).toBe(true);
  });

  test("falls back (no throw) for a truthy non-string icon", () => {
    // A bad data row carrying a number/object must not crash the render.
    expect(iconUrl(12345)).toBe(BLANK);
    expect(iconUrl({})).toBe(BLANK);
  });
});

describe("onIconError", () => {
  test("swaps a failed icon for the blank pixel", () => {
    const target = { src: "/talent-icons/missing.jpg" };
    onIconError({ currentTarget: target });
    expect(target.src).toBe(BLANK);
  });

  test("does not re-assign once already blank (no error loop)", () => {
    let writes = 0;
    const target = {
      _src: BLANK,
      get src() {
        return this._src;
      },
      set src(v) {
        writes++;
        this._src = v;
      },
    };
    onIconError({ currentTarget: target });
    expect(writes).toBe(0);
    expect(target.src).toBe(BLANK);
  });
});

describe("classIconSlug", () => {
  // One formula shared by BuildManager's class grid and scripts/fetchIcons.js;
  // these pin the shape so neither consumer can drift from the committed icons.
  test("builds the lowercased, underscore-free class icon slug", () => {
    expect(classIconSlug("death_knight")).toBe("classicon_deathknight");
    expect(classIconSlug("Mage")).toBe("classicon_mage");
  });

  test("degrades a malformed name instead of throwing", () => {
    expect(classIconSlug(undefined)).toBe("classicon_");
    expect(classIconSlug(null)).toBe("classicon_");
  });
});

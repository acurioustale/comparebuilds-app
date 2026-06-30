import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import classes from "../data/classes.json";

// og.php hardcodes a CLASS_INFO map (class id => [display name, hex colour]) so
// the OG card can render for any share without the class data on the server. That
// duplicates the displayName + color already carried per class in classes.json,
// with no shared module across JS and PHP. This test pins the PHP copy to the JSON
// source of truth so a class rename or colour change can't silently fail to reach
// the preview card, mirroring limitsParity.test.js and shareIdParity.test.js.

const ogPhp = readFileSync(
  fileURLToPath(new URL("../../api/og.php", import.meta.url)),
  "utf8",
);

// Parse each `<id> => ['<name>', '<#color>']` entry from the CLASS_INFO literal.
const phpClassInfo = (() => {
  const block = ogPhp.match(/const\s+CLASS_INFO\s*=\s*\[([\s\S]*?)\];/);
  if (!block) throw new Error("could not find CLASS_INFO in og.php");
  const entries = new Map();
  const re = /(\d+)\s*=>\s*\[\s*'([^']*)'\s*,\s*'(#[0-9A-Fa-f]{6})'\s*\]/g;
  let m;
  while ((m = re.exec(block[1])) !== null) {
    entries.set(Number(m[1]), { displayName: m[2], color: m[3] });
  }
  return entries;
})();

const byId = new Map(classes.map((c) => [c.id, c]));

describe("og.php CLASS_INFO parity with classes.json", () => {
  test("CLASS_INFO parses into a non-empty map", () => {
    expect(phpClassInfo.size).toBeGreaterThan(0);
  });

  test("every CLASS_INFO entry matches the class in classes.json", () => {
    for (const [id, info] of phpClassInfo) {
      const cls = byId.get(id);
      expect(cls, `class id ${id} missing from classes.json`).toBeDefined();
      expect(info.displayName).toBe(cls.displayName);
      // Hex colours compare case-insensitively.
      expect(info.color.toLowerCase()).toBe(cls.color.toLowerCase());
    }
  });

  test("every implemented class in classes.json appears in CLASS_INFO", () => {
    for (const cls of classes) {
      if (cls.implemented === false) continue;
      expect(
        phpClassInfo.has(cls.id),
        `class id ${cls.id} (${cls.displayName}) missing from og.php CLASS_INFO`,
      ).toBe(true);
    }
  });
});

import { describe, it, expect } from "vitest";
import { deriveHashes } from "./generateLayoutManifest.js";
import snapshot from "../src/lib/wireLayout.snapshot.json";

describe("deriveHashes", () => {
  it("maps every snapshot class to its layout hash", () => {
    const hashes = deriveHashes(snapshot);
    const classKeys = Object.keys(snapshot);
    expect(Object.keys(hashes)).toEqual(classKeys);
    for (const key of classKeys) {
      expect(hashes[key]).toBe(snapshot[key].hash);
      // The manifest hashes must satisfy the server's layoutHash validator.
      expect(hashes[key]).toMatch(/^[a-fA-F0-9]{1,16}$/);
    }
  });

  it("throws when a snapshot entry is missing its hash", () => {
    expect(() => deriveHashes({ mage: { count: 3 } })).toThrow(
      /missing a hash/,
    );
  });

  it("throws on an empty snapshot rather than emit a mass-supersession manifest", () => {
    expect(() => deriveHashes({})).toThrow(
      /refusing to write an empty manifest/,
    );
  });
});

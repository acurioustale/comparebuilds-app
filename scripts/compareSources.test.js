import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { diffClass, parseArgs } from "./compareSources.js";

const require = createRequire(import.meta.url);
const DK = require("../src/data/death_knight.json");

describe("compareSources diffClass", () => {
  const opts = { descriptions: false };

  it("has no hard divergences when fresh matches committed", () => {
    expect(diffClass("death_knight", DK, DK, opts).hard).toEqual([]);
  });

  it("reports a spec present only in the fresh ingest as a hard divergence", () => {
    // A game patch adds a brand-new spec the committed data doesn't have yet.
    // The committed-keyed loop never reaches it, so without the fresh-only pass
    // its heroGate/gates/wiring go unvalidated and the drift isn't localized.
    const firstSpec = DK.specs[Object.keys(DK.specs)[0]];
    const fresh = { ...DK, specs: { ...DK.specs, testspec: firstSpec } };

    const { hard } = diffClass("death_knight", fresh, DK, opts);
    expect(hard).toContain(
      "testspec: new spec in fresh ingest (not in committed)",
    );
  });

  it("reports a spec missing from the fresh ingest as a hard divergence", () => {
    // Symmetric removal case (the existing `!fSpec` branch).
    const removed = Object.keys(DK.specs)[0];
    const specs = { ...DK.specs };
    delete specs[removed];
    const fresh = { ...DK, specs };

    const { hard } = diffClass("death_knight", fresh, DK, opts);
    expect(hard).toContain(`${removed}: missing from fresh ingest`);
  });
});

describe("compareSources parseArgs", () => {
  // Same hazard as ingestBlizzard: an empty slug is falsy, so it would disable
  // the class filter instead of narrowing it.
  it("rejects an empty --class= value", () => {
    expect(() => parseArgs(["--class="])).toThrow(/--class= requires a class/);
  });

  it("accepts a non-empty --class= value", () => {
    expect(parseArgs(["--class=mage"]).classSlug).toBe("mage");
  });
});

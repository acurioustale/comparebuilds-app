import { describe, test, expect } from "vitest";
import { defaultBuildLabel, buildOrdinal } from "./buildLabel";

describe("buildOrdinal", () => {
  const ordinals = (parsed) => {
    const validCount = parsed.filter(Boolean).length;
    let rank = 0;
    return parsed.map((p, i) =>
      buildOrdinal({
        slotNumber: i + 1,
        validRank: p ? ++rank : null,
        validCount,
      }),
    );
  };

  test("names the pair A/B when exactly two builds parse", () => {
    expect(ordinals([true, true])).toEqual(["A", "B"]);
  });

  test("names the pair A/B by parse order, not slot number", () => {
    // Slots 2 and 3 hold the only two builds being diffed. Keying A/B off the
    // slot number would make both of them "B".
    expect(ordinals([false, true, true])).toEqual([1, "A", "B"]);
  });

  test("keeps slot numbers when only one of two slots parses", () => {
    // One valid build renders the single-build view, which has no A/B pairing.
    expect(ordinals([true, false])).toEqual([1, 2]);
  });

  test("keeps slot numbers for three or more builds, leaving no duplicates", () => {
    expect(ordinals([true, true, true])).toEqual([1, 2, 3]);
    expect(ordinals([false, true, true, true])).toEqual([1, 2, 3, 4]);
  });

  test("keeps slot numbers while nothing has parsed yet", () => {
    expect(ordinals([false, false])).toEqual([1, 2]);
  });
});

describe("defaultBuildLabel", () => {
  const treeData = {
    nodes: [
      {
        id: 101,
        treeType: "hero",
        name: "Hero Node",
        heroSubtree: "San'layn",
      },
    ],
  };

  test("includes the active hero subtree prefix when one is selected", () => {
    const parsedBuild = { nodes: { 101: { pointsInvested: 1 } } };
    expect(
      defaultBuildLabel({
        ordinal: 1,
        className: "Death Knight",
        specName: "Blood",
        treeData,
        parsedBuild,
      }),
    ).toBe("Build 1 — San'layn Blood Death Knight");
  });

  test("omits the hero prefix when no hero subtree is active", () => {
    const parsedBuild = { nodes: {} };
    expect(
      defaultBuildLabel({
        ordinal: 2,
        className: "Death Knight",
        specName: "Blood",
        treeData,
        parsedBuild,
      }),
    ).toBe("Build 2 — Blood Death Knight");
  });

  test("omits the hero prefix when tree data or parse is missing", () => {
    expect(
      defaultBuildLabel({
        ordinal: 3,
        className: "Death Knight",
        specName: "Blood",
        treeData: null,
        parsedBuild: null,
      }),
    ).toBe("Build 3 — Blood Death Knight");
  });

  test("collapses to 'Build N' when class or spec name is absent", () => {
    expect(
      defaultBuildLabel({
        ordinal: 4,
        className: "Death Knight",
        specName: "",
        treeData,
        parsedBuild: { nodes: { 101: { pointsInvested: 1 } } },
      }),
    ).toBe("Build 4");
    expect(
      defaultBuildLabel({
        ordinal: 5,
        className: undefined,
        specName: "Blood",
        treeData,
        parsedBuild: { nodes: { 101: { pointsInvested: 1 } } },
      }),
    ).toBe("Build 5");
  });

  test("renders an A/B ordinal verbatim", () => {
    const parsedBuild = { nodes: {} };
    expect(
      defaultBuildLabel({
        ordinal: "A",
        className: "Death Knight",
        specName: "Blood",
        treeData,
        parsedBuild,
      }),
    ).toBe("Build A — Blood Death Knight");
    expect(
      defaultBuildLabel({
        ordinal: "B",
        className: "Death Knight",
        specName: "Blood",
        treeData,
        parsedBuild,
      }),
    ).toBe("Build B — Blood Death Knight");
  });

  test("A/B applies to the 'Build N' fallback too", () => {
    expect(
      defaultBuildLabel({ ordinal: "A", specName: "", className: "" }),
    ).toBe("Build A");
    expect(
      defaultBuildLabel({ ordinal: "B", specName: "", className: "" }),
    ).toBe("Build B");
  });
});

// @vitest-environment jsdom
/**
 * The comparison-only view state (the "Differences only" filter and the
 * DiffSummaryTable spotlight) lives in MainView but only has meaning while two
 * or more builds are compared. Dropping to one build must not leave either one
 * applied, even for the single commit before the reset effect runs — with no
 * highlights every node reads as unchanged, so the whole tree would clamp to
 * 0.12 opacity and visibly fade.
 *
 * A passive effect cannot express that: it runs after the offending commit has
 * already painted. These tests observe the commit itself by standing a probe in
 * for the single-build view's TalentTree and recording the context values it is
 * rendered with — so an intermediate frame that a post-effect assertion would
 * never see is caught.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  act,
  fireEvent,
} from "@testing-library/react";

// Records what the single-build tree was rendered with, on EVERY render.
// Populated by the mock below; declared via vi.hoisted so the hoisted factory
// can close over it.
const { treeRenders } = vi.hoisted(() => ({ treeRenders: [] }));

// TalentTree's default export is rendered by exactly two callers: MainView's
// SingleBuildView, and InteractiveTalentTree (which needs zero valid builds, so
// it never mounts in these tests). Replacing it therefore gives a probe that
// renders if and only if the single-build view is on screen. TreePanel — the
// named export SideBySideDiff draws the paired view with — is left real, so the
// two-build view and its "Differences only" toggle still work.
vi.mock("./TalentTree.jsx", async (importOriginal) => {
  const actual = await importOriginal();
  const { useContext } = await import("react");
  const { ChangesFilterContext, SpotlightContext } =
    await import("./SearchContext.js");
  return {
    ...actual,
    default: function TalentTreeProbe() {
      treeRenders.push({
        changesFilter: useContext(ChangesFilterContext),
        spotlight: useContext(SpotlightContext),
      });
      return null;
    },
  };
});

import MainView from "./MainView.jsx";
import { useBuildsStore } from "../store/buildsStore.js";
import { genStrings } from "../test/buildStrings.js";

const load = async (strings) => {
  for (const s of strings) {
    await act(async () => {
      await useBuildsStore.getState().addBuild(s);
    });
  }
};

/** Drops to a single build, the transition the reset effect used to lag behind. */
const removeBuild = async (index) => {
  await act(async () => {
    useBuildsStore.getState().removeBuild(index);
  });
};

beforeEach(() => {
  treeRenders.length = 0;
  useBuildsStore.getState().clearAllBuilds();
});
afterEach(() => {
  cleanup();
});

describe("comparison-only view state never reaches the single-build tree", () => {
  test("the changes filter is off in every single-build commit", async () => {
    await load(genStrings("death_knight", "blood", 2));
    render(<MainView />);

    // Two builds: the paired view is up and the probe has not rendered at all.
    expect(treeRenders).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Differences only" }));
    expect(
      screen.getByRole("button", { name: "Differences only" }),
    ).toHaveAttribute("aria-pressed", "true");

    await removeBuild(1);

    // Every commit that rendered the single-build tree — including the first,
    // which is the one a passive reset effect could not have reached in time.
    expect(treeRenders.length).toBeGreaterThan(0);
    expect(treeRenders.map((r) => r.changesFilter)).not.toContain(true);
  });

  test("the spotlight is clear in every single-build commit", async () => {
    await load(genStrings("death_knight", "blood", 2));
    render(<MainView />);

    // Hovering a summary row pins the spotlight, which dims every other node.
    const row = screen.getAllByRole("row").at(-1);
    fireEvent.mouseEnter(row);

    await removeBuild(1);

    expect(treeRenders.length).toBeGreaterThan(0);
    for (const r of treeRenders) expect(r.spotlight).toBeNull();
  });

  test("the filter still applies while two builds are compared", async () => {
    // The guard must not simply disable the feature: with the pair up, the
    // toggle still drives the context the tree renderers read.
    await load(genStrings("death_knight", "blood", 2));
    render(<MainView />);

    fireEvent.click(screen.getByRole("button", { name: "Differences only" }));

    // Drop to one build and add a second back: the toggle resets rather than
    // silently re-arming, so the pair comes back undimmed.
    await removeBuild(1);
    expect(
      screen.queryByRole("button", { name: "Differences only" }),
    ).not.toBeInTheDocument();

    await load(genStrings("death_knight", "blood", 2).slice(1));
    expect(
      screen.getByRole("button", { name: "Differences only" }),
    ).toHaveAttribute("aria-pressed", "false");
  });
});

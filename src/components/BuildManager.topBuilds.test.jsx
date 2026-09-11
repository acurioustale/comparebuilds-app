// @vitest-environment jsdom
/**
 * Component-flow tests for the top-sims reference builds in BuildManager,
 * driving the real store: spec selection → availability → loaded, named slots.
 *
 * The two branches that matter here are the ones a unit test of the pure
 * helpers can't show: that the control appears only for a spec the shipped
 * table covers, and that it disappears once the slots are full.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
} from "@testing-library/react";
import { createRequire } from "node:module";
import BuildManager from "./BuildManager.jsx";
import { useBuildsStore, MAX_BUILDS } from "../store/buildsStore.js";

const require = createRequire(import.meta.url);
const table = require("../data/topBuilds.json");
const classIndex = require("../data/classes.json");

/** A class whose first spec the table covers, and one it does not. */
const covered = classIndex
  .filter((c) => c.implemented)
  .flatMap((c) => c.specs.map((s) => ({ cls: c, spec: s })))
  .find(({ spec }) => (table.specs[String(spec.id)] ?? []).length >= 2);
const uncovered = classIndex
  .filter((c) => c.implemented)
  .flatMap((c) => c.specs.map((s) => ({ cls: c, spec: s })))
  .find(({ spec }) => !(String(spec.id) in table.specs));

const BUTTON = /add top simmed builds/i;

/**
 * Render with a spec selected. The class grid is icon-only (no accessible
 * name), so the selection goes through the store's own preloadSpec — the same
 * call the spec row makes — rather than through a brittle icon click.
 */
async function selectSpec({ spec }) {
  render(<BuildManager />);
  await act(async () => {
    await useBuildsStore.getState().preloadSpec(spec.id);
  });
}

beforeEach(() => {
  useBuildsStore.getState().clearAllBuilds();
});
afterEach(cleanup);

describe("top-sims reference builds", () => {
  test("no control before a spec is chosen", () => {
    render(<BuildManager />);
    expect(screen.queryByRole("button", { name: BUTTON })).toBeNull();
  });

  test("offers the builds once a covered spec is selected", async () => {
    await selectSpec(covered);
    expect(
      await screen.findByRole("button", { name: BUTTON }),
    ).toBeInTheDocument();
    // Provenance is part of the feature, not decoration: the table is a dated
    // snapshot of someone else's data and has to say so.
    expect(screen.getByRole("link", { name: /raidbots/i })).toHaveAttribute(
      "href",
      expect.stringContaining("raidbots.com"),
    );
    expect(screen.getByText(new RegExp(table.generatedAt))).toBeInTheDocument();
  });

  test("stays hidden for a spec the sample does not cover", async () => {
    // DPS-sim data: seven healing specs have no entries at all. Offering a
    // button that could only report "nothing here" would be worse than none.
    if (!uncovered) return;
    await selectSpec(uncovered);
    expect(useBuildsStore.getState().specId).toBe(uncovered.spec.id);
    expect(screen.queryByRole("button", { name: BUTTON })).toBeNull();
  });

  test("clicking it fills the slots with named builds and then hides itself", async () => {
    await selectSpec(covered);
    fireEvent.click(await screen.findByRole("button", { name: BUTTON }));

    const expected = Math.min(
      table.specs[String(covered.spec.id)].length,
      MAX_BUILDS,
    );
    await waitFor(() =>
      expect(useBuildsStore.getState().buildStrings).toHaveLength(expected),
    );
    expect(
      await screen.findByDisplayValue(/Top sim #1 \(\d+ sims?\)/),
    ).toBeInTheDocument();

    // With every slot taken there is nothing left to add, so the control goes.
    if (expected === MAX_BUILDS)
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: BUTTON })).toBeNull(),
      );
  });
});

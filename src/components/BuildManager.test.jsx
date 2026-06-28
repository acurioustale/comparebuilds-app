// @vitest-environment jsdom
/**
 * Component-flow tests for BuildManager — driving the real store through the UI.
 * Verifies the import → parsed-label flow, the duplicate guard surfacing in the
 * UI, and clear-all, end to end (paste → store → rendered result).
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { createRequire } from "node:module";
import BuildManager from "./BuildManager.jsx";
import { useBuildsStore } from "../store/buildsStore.js";
import { collectClassNodes, generateBuildString } from "../lib/buildString.js";

const require = createRequire(import.meta.url);

/** n distinct, valid build strings for one class+spec (selecting 1..n nodes). */
function genStrings(classSlug, specSlug, n) {
  const data = require(`../data/${classSlug}.json`);
  const classNodes = collectClassNodes(data);
  const spec = data.specs[specSlug];
  const pickable = spec.nodes.filter((nd) => !nd.alreadyGranted);
  const out = [];
  for (let k = 1; k <= n; k++) {
    const sel = {};
    for (let i = 0; i < k; i++) {
      const nd = pickable[i];
      sel[nd.id] = {
        pointsInvested:
          nd.type === "choice" ? nd.choices[0].maxRanks : nd.maxRanks,
        entryChosen: nd.type === "choice" ? 0 : null,
      };
    }
    out.push(generateBuildString(sel, spec.specId, classNodes));
  }
  return out;
}

/** Paste a string into a build-input field, triggering the auto-submit handler. */
function paste(input, text) {
  fireEvent.paste(input, { clipboardData: { getData: () => text } });
}

beforeEach(() => {
  useBuildsStore.getState().clearAllBuilds();
});
afterEach(() => {
  cleanup();
});

describe("BuildManager import flow", () => {
  test("pasting a valid build string shows its parsed label", async () => {
    render(<BuildManager />);
    const [s] = genStrings("death_knight", "blood", 1);
    paste(screen.getAllByPlaceholderText("Paste build string…")[0], s);
    expect(
      await screen.findByPlaceholderText(/Blood Death Knight/),
    ).toBeInTheDocument();
  });

  test("pasting an exact duplicate surfaces the duplicate error", async () => {
    render(<BuildManager />);
    const [s] = genStrings("death_knight", "blood", 1);
    paste(screen.getAllByPlaceholderText("Paste build string…")[0], s);
    await screen.findByPlaceholderText(/Blood Death Knight/);
    // After the first add there is a single empty input — paste the same string.
    paste(screen.getByPlaceholderText("Paste build string…"), s);
    expect(await screen.findByText(/already been added/i)).toBeInTheDocument();
  });

  test("an unparseable string surfaces an error and adds nothing", async () => {
    render(<BuildManager />);
    paste(
      screen.getAllByPlaceholderText("Paste build string…")[0],
      "not-a-real-build",
    );
    expect(
      await screen.findByText(
        /could not read|not found|invalid|unsupported|version/i,
      ),
    ).toBeInTheDocument();
    expect(useBuildsStore.getState().buildStrings.length).toBe(0);
  });

  test("clear all removes loaded builds", async () => {
    render(<BuildManager />);
    const [s] = genStrings("death_knight", "blood", 1);
    paste(screen.getAllByPlaceholderText("Paste build string…")[0], s);
    await screen.findByPlaceholderText(/Blood Death Knight/);
    fireEvent.click(screen.getByText("Clear all"));
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/Blood Death Knight/)).toBeNull(),
    );
  });

  test("clicking the pencil button triggers editBuild", async () => {
    render(<BuildManager />);
    const [s] = genStrings("death_knight", "blood", 1);
    paste(screen.getAllByPlaceholderText("Paste build string…")[0], s);
    await screen.findByPlaceholderText(/Blood Death Knight/);
    const pencilBtn = await screen.findByRole("button", { name: "Edit build" });
    fireEvent.click(pencilBtn);
    expect(useBuildsStore.getState().addingBuild).toBe(true);
    expect(useBuildsStore.getState().editingIndex).toBe(0);
  });
});

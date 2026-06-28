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

  test("pencil button opens build for editing", async () => {
    render(<BuildManager />);
    const [s] = genStrings("death_knight", "blood", 1);
    paste(screen.getAllByPlaceholderText("Paste build string…")[0], s);
    await screen.findByPlaceholderText(/Blood Death Knight/);
    const pencil = await screen.findByLabelText("Edit build 1");
    expect(pencil).toBeInTheDocument();
    fireEvent.click(pencil);
    expect(useBuildsStore.getState().editingIndex).toBe(0);
  });

  test("export menu opens and displays share actions", async () => {
    render(<BuildManager />);
    const [a, b] = genStrings("death_knight", "blood", 2);
    paste(screen.getAllByPlaceholderText("Paste build string…")[0], a);
    await screen.findByPlaceholderText(/Build 1 — Blood Death Knight/);
    paste(screen.getByPlaceholderText("Paste build string…"), b);
    await screen.findByPlaceholderText(/Build 2 — Blood Death Knight/);

    const exportBtn = await screen.findByRole("button", {
      name: /Export \/ Share/i,
    });
    expect(exportBtn).toBeInTheDocument();
    fireEvent.click(exportBtn);

    const shortLinkBtn = await screen.findByText(/Copy short link/i);
    const instantLinkBtn = await screen.findByText(/Copy instant link/i);
    expect(shortLinkBtn).toBeInTheDocument();
    expect(instantLinkBtn).toBeInTheDocument();

    fireEvent.click(instantLinkBtn);
    await waitFor(() => {
      expect(screen.getByText(/Export \/ Share/i)).toBeInTheDocument();
    });
  });

  test("export menu closes on Escape", async () => {
    render(<BuildManager />);
    const [a, b] = genStrings("death_knight", "blood", 2);
    paste(screen.getAllByPlaceholderText("Paste build string…")[0], a);
    await screen.findByPlaceholderText(/Build 1 — Blood Death Knight/);
    paste(screen.getByPlaceholderText("Paste build string…"), b);
    await screen.findByPlaceholderText(/Build 2 — Blood Death Knight/);

    fireEvent.click(
      await screen.findByRole("button", { name: /Export \/ Share/i }),
    );
    await screen.findByText(/Copy short link/i);
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByText(/Copy short link/i)).toBeNull(),
    );
  });
});

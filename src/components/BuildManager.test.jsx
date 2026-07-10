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
import BuildManager, { ClassIcon } from "./BuildManager.jsx";
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

  test("unsubmitted typed text in the empty slot survives removing a build", async () => {
    render(<BuildManager />);
    const [a, b] = genStrings("death_knight", "blood", 2);
    paste(screen.getAllByPlaceholderText("Paste build string…")[0], a);
    await screen.findByPlaceholderText(/Build 1 — Blood Death Knight/);
    paste(screen.getByPlaceholderText("Paste build string…"), b);
    await screen.findByPlaceholderText(/Build B — Blood Death Knight/);

    // Type (but do not submit) a third build string into the empty slot.
    fireEvent.change(screen.getByPlaceholderText("Paste build string…"), {
      target: { value: "draft-build-string" },
    });

    // Remove the first build — this shifts every slot index down by one.
    fireEvent.click(screen.getAllByTitle("Remove")[0]);
    await waitFor(() =>
      expect(useBuildsStore.getState().buildStrings.length).toBe(1),
    );

    // The empty input must keep the unsubmitted draft rather than remounting.
    expect(screen.getByPlaceholderText("Paste build string…").value).toBe(
      "draft-build-string",
    );
  });

  test("renders both share action buttons once builds are added", async () => {
    render(<BuildManager />);
    const [a, b] = genStrings("death_knight", "blood", 2);
    paste(screen.getAllByPlaceholderText("Paste build string…")[0], a);
    await screen.findByPlaceholderText(/Build 1 — Blood Death Knight/);
    paste(screen.getByPlaceholderText("Paste build string…"), b);
    await screen.findByPlaceholderText(/Build B — Blood Death Knight/);

    // Both actions are surfaced directly as buttons — no popover to open.
    expect(
      await screen.findByRole("button", { name: /Copy simc profileset/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Share link/i }),
    ).toBeInTheDocument();
  });

  test("simc button shows a busy label, never a blank one, while copying", async () => {
    // Hold the clipboard write open so the transient "copying" state stays
    // rendered — the button must show "Copying…" rather than an empty label.
    let resolveWrite;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () => new Promise((r) => (resolveWrite = r)),
      },
    });

    render(<BuildManager />);
    const [a, b] = genStrings("death_knight", "blood", 2);
    paste(screen.getAllByPlaceholderText("Paste build string…")[0], a);
    await screen.findByPlaceholderText(/Build 1 — Blood Death Knight/);
    paste(screen.getByPlaceholderText("Paste build string…"), b);
    await screen.findByPlaceholderText(/Build B — Blood Death Knight/);

    const simc = await screen.findByRole("button", {
      name: /Copy simc profileset/i,
    });
    fireEvent.click(simc);

    // Mid-copy the label must be the busy text, not blank.
    const busy = await screen.findByRole("button", { name: /Copying…/i });
    expect(busy.textContent.trim()).not.toBe("");

    resolveWrite();
    await screen.findByRole("button", { name: /Copied!/i });
  });
});

describe("cold-start CTA", () => {
  test("offers a start-from-scratch jump into the calculator with no builds", () => {
    render(<BuildManager />);
    expect(
      screen.getByRole("button", { name: /start from scratch/i }),
    ).toBeInTheDocument();
  });

  test("clicking it loads a spec's tree without requiring a build string", async () => {
    render(<BuildManager />);
    fireEvent.click(
      screen.getByRole("button", { name: /start from scratch/i }),
    );
    await waitFor(() =>
      expect(useBuildsStore.getState().treeData).not.toBeNull(),
    );
    expect(useBuildsStore.getState().buildStrings).toEqual([]);
    // The CTA steps aside once the calculator flow is underway.
    expect(
      screen.queryByRole("button", { name: /start from scratch/i }),
    ).toBeNull();
  });

  test("is not shown once a build has been pasted", async () => {
    render(<BuildManager />);
    const [s] = genStrings("death_knight", "blood", 1);
    paste(screen.getAllByPlaceholderText("Paste build string…")[0], s);
    await screen.findByPlaceholderText(/Blood Death Knight/);
    expect(
      screen.queryByRole("button", { name: /start from scratch/i }),
    ).toBeNull();
  });
});

describe("class grid", () => {
  // Regression: handleClassSelect had no same-class guard, so clicking the
  // already-highlighted class icon (clickable while the grid is unlocked) hit
  // the interactive-mode clearAllBuilds and wiped an in-progress selection —
  // unlike preloadSpec, whose same-spec guard exists for exactly this.
  test("clicking the already-active class keeps the in-progress interactive selection", async () => {
    const data = require("../data/death_knight.json");
    await useBuildsStore.getState().preloadSpec(data.specs.blood.specId);
    const seed = useBuildsStore.getState().interactiveNodes;
    const pick = data.specs.blood.nodes.find((nd) => !nd.alreadyGranted);
    const selection = {
      ...seed,
      [pick.id]: {
        pointsInvested: pick.type === "choice" ? 1 : pick.maxRanks,
        entryChosen: pick.type === "choice" ? 0 : null,
      },
    };
    useBuildsStore.getState().setInteractiveNodes(selection);

    render(<BuildManager />);
    fireEvent.click(await screen.findByRole("button", { pressed: true }));

    const st = useBuildsStore.getState();
    expect(st.interactiveNodes).toEqual(selection);
    expect(st.specId).toBe(data.specs.blood.specId);
    expect(st.treeData).not.toBeNull();
  });

  test("clicking a different class still resets the interactive state", async () => {
    const data = require("../data/death_knight.json");
    await useBuildsStore.getState().preloadSpec(data.specs.blood.specId);

    render(<BuildManager />);
    await screen.findByRole("button", { pressed: true });
    const other = screen
      .getAllByRole("button", { pressed: false })
      .find((b) => b.querySelector("img"));
    fireEvent.click(other);

    // The class change clears the loaded spec/tree back to a clean slate.
    const st = useBuildsStore.getState();
    expect(st.specId).toBeNull();
    expect(st.treeData).toBeNull();
    expect(st.interactiveNodes).toEqual({});
  });
});

describe("ClassIcon", () => {
  // classes.json is not schema-validated; a malformed row (missing/non-string
  // name) must not throw and unmount the whole panel — it degrades to a broken
  // icon that onIconError swaps for a fallback.
  test("renders without throwing when the name is missing", () => {
    expect(() => render(<ClassIcon name={undefined} />)).not.toThrow();
    const img = document.querySelector("img");
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toContain("classicon_");
  });
});

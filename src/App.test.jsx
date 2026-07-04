// @vitest-environment jsdom
/**
 * App-level flow tests: the two-build comparison view, share-link rehydration,
 * and the StrictMode double-invoke guard (regression test for the fix that
 * stopped shared builds from being added twice in development).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { StrictMode } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { createRequire } from "node:module";
import App from "./App.jsx";
import { useBuildsStore } from "./store/buildsStore.js";
import { collectClassNodes, generateBuildString } from "./lib/buildString.js";

const require = createRequire(import.meta.url);

function genStrings(classSlug, specSlug, n) {
  const data = require(`./data/${classSlug}.json`);
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

const paste = (input, text) =>
  fireEvent.paste(input, { clipboardData: { getData: () => text } });

function mockShareFetch(builds) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ classId: 6, specId: 250, builds }),
  }));
  global.fetch = fetchMock;
  return fetchMock;
}

// This jsdom setup has no localStorage (the store is built to run without it),
// so the theme suite installs a minimal in-memory stub for the tests that need
// to read a persisted choice back. Guarded with ?. so the other suites, which
// run without it, are unaffected.
function installLocalStorage() {
  const store = new Map();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => {
        store.set(k, String(v));
      },
      removeItem: (k) => {
        store.delete(k);
      },
      clear: () => {
        store.clear();
      },
    },
  });
}

beforeEach(() => {
  useBuildsStore.getState().clearAllBuilds();
  window.location.hash = "";
  window.localStorage?.clear();
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  cleanup();
  window.location.hash = "";
  window.localStorage?.clear();
  delete document.documentElement.dataset.theme;
  vi.restoreAllMocks();
  delete global.fetch;
});

describe("comparison view", () => {
  test("adding two builds renders the side-by-side diff", async () => {
    render(<App />);
    const [a, b] = genStrings("death_knight", "blood", 2);
    paste(screen.getAllByPlaceholderText("Paste build string…")[0], a);
    await screen.findByPlaceholderText(/Build 1 — Blood Death Knight/);
    paste(screen.getByPlaceholderText("Paste build string…"), b);
    // Scope to the diff's heading <p>; the "Differences only" toggle button
    // also contains the word "Differences".
    expect(
      await screen.findByText(/Differences/, { selector: "p" }),
    ).toBeInTheDocument();
  });

  test("shows an empty-state notice when a pasted build can't be decoded", async () => {
    // Silence the expected parse-failure log the store emits for the bad string.
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<App />);
    // A valid 24-bit header (the spec resolves, so the tree loads) but a
    // truncated body that fails the full parse — the build is added yet its
    // parsed slot stays null, leaving no tree/diff/heatmap to show.
    const bad = genStrings("death_knight", "blood", 1)[0].slice(0, 8);
    paste(screen.getAllByPlaceholderText("Paste build string…")[0], bad);
    expect(await screen.findByText(/Nothing to compare/i)).toBeInTheDocument();
  });
});

describe("spotlight cleanup", () => {
  // Regression: hovering a DiffSummaryTable row sets spotlightId, which dims
  // every other tree node to opacity 0.3. The table only renders while comparing
  // (>= 2 valid builds). Removing a build while a row is hovered unmounts the
  // table before its mouseleave fires, so without the MainView cleanup effect the
  // spotlight stayed set and kept dimming nodes with no way to clear it.
  const dimmedCount = (root) =>
    Array.from(root.querySelectorAll('[style*="opacity: 0.3"]')).length;

  test("clears the spotlight when a build is removed below the comparison threshold", async () => {
    const { container } = render(<App />);
    const [a, b] = genStrings("death_knight", "blood", 2);
    paste(screen.getAllByPlaceholderText("Paste build string…")[0], a);
    await screen.findByPlaceholderText(/Build 1 — Blood Death Knight/);
    paste(screen.getByPlaceholderText("Paste build string…"), b);
    await screen.findByText(/Differences/, { selector: "p" });

    // Hover a summary row to spotlight its node — other nodes dim to 0.3.
    // (Section-header rows have a single colSpan `td`; a real data row has
    // one `td` per column, so requiring more than one skips the headers.)
    const row = (await screen.findAllByRole("row")).find(
      (r) => r.querySelectorAll("td").length > 1,
    );
    fireEvent.mouseEnter(row);
    expect(dimmedCount(container)).toBeGreaterThan(0);

    // Remove a build (drops to one valid build) WITHOUT the row's mouseleave.
    fireEvent.click(screen.getAllByTitle("Remove")[0]);

    // The diff summary is gone and the lingering spotlight is cleared.
    expect(screen.queryByText(/Differences/, { selector: "p" })).toBeNull();
    expect(dimmedCount(container)).toBe(0);
  });
});

describe("share rehydration", () => {
  test("loads builds referenced by the URL hash", async () => {
    const builds = genStrings("death_knight", "blood", 2);
    const fetchMock = mockShareFetch(builds);
    window.location.hash = "#abc123xy";

    render(<App />);

    // Scope to the diff's heading <p>; the "Differences only" toggle button
    // also contains the word "Differences".
    expect(
      await screen.findByText(/Differences/, { selector: "p" }),
    ).toBeInTheDocument();
    // Exactly one data fetch, plus one uncached liveness beacon (?touch=1).
    const dataCalls = fetchMock.mock.calls.filter(
      ([u]) => !u.includes("touch=1"),
    );
    const touchCalls = fetchMock.mock.calls.filter(([u]) =>
      u.includes("touch=1"),
    );
    expect(dataCalls).toHaveLength(1);
    expect(touchCalls).toHaveLength(1);
    // The beacon must bypass the immutable cache so it actually reaches the server.
    expect(touchCalls[0][1]).toMatchObject({
      cache: "no-store",
      keepalive: true,
    });
    // hash is cleared so a manual reload doesn't re-trigger
    expect(window.location.hash).toBe("");
  });

  test("dedupes duplicate builds in a share, labels the survivor from the first occurrence, and strips the hash", async () => {
    const [a] = genStrings("death_knight", "blood", 1);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        classId: 6,
        specId: 250,
        builds: [a, a],
        labels: ["First", "Second"],
      }),
    }));
    global.fetch = fetchMock;
    window.location.hash = "#dupdupdu";

    render(<App />);

    // The survivor is labelled from the first occurrence ("First"), not the
    // duplicate's "Second" — proving the dedupe and the first-wins label map.
    await screen.findByDisplayValue("First");
    const state = useBuildsStore.getState();
    expect(state.buildStrings).toEqual([a]);
    // The hash is stripped despite the second (duplicate) entry being rejected,
    // so a reload can't re-fetch the same share and loop forever.
    expect(window.location.hash).toBe("");
  });

  test("a bad hash is ignored (no fetch)", async () => {
    const fetchMock = mockShareFetch([]);
    window.location.hash = "#tooShortAndWeird!!";
    render(<App />);
    // Nothing to load — the empty build inputs remain
    expect(screen.getAllByRole("textbox").length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rehydration runs only once under StrictMode", async () => {
    const builds = genStrings("death_knight", "blood", 2);
    const fetchMock = mockShareFetch(builds);
    window.location.hash = "#abcdefgh";

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    // Scope to the diff's heading <p>; the "Differences only" toggle button
    // also contains the word "Differences".
    expect(
      await screen.findByText(/Differences/, { selector: "p" }),
    ).toBeInTheDocument();
    // The useRef guard prevents StrictMode's double effect invocation from
    // fetching (and adding the builds) twice: one data fetch, one beacon.
    const dataCalls = fetchMock.mock.calls.filter(
      ([u]) => !u.includes("touch=1"),
    );
    const touchCalls = fetchMock.mock.calls.filter(([u]) =>
      u.includes("touch=1"),
    );
    expect(dataCalls).toHaveLength(1);
    expect(touchCalls).toHaveLength(1);
  });
});

describe("theme toggle", () => {
  beforeEach(installLocalStorage);
  afterEach(() => {
    delete window.localStorage;
  });

  // The matchMedia stub reports prefers-color-scheme: light → false, so the OS
  // is dark here. The cycle order is therefore auto → light → dark → auto. "auto"
  // sets no data-theme attribute — the CSS color-scheme/light-dark() palette
  // follows the OS itself — so the attribute is present only for explicit modes.
  test("defaults to auto (no data-theme attribute) and offers the light step first", () => {
    render(<App />);

    expect(document.documentElement.dataset.theme).toBeUndefined();
    // Nothing is persisted until the user actually cycles.
    expect(window.localStorage.getItem("comparebuilds-theme")).toBeNull();
    expect(
      screen.getByRole("button", { name: /switch to light/i }),
    ).toBeInTheDocument();
  });

  test("cycles auto → light → dark → auto, sets data-theme only for explicit modes, and persists each", () => {
    render(<App />);

    const toggle = () => screen.getByRole("button", { name: /switch to/i });

    // auto → light: explicit override sets the attribute and persists.
    fireEvent.click(toggle());
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem("comparebuilds-theme")).toBe("light");

    // light → dark.
    fireEvent.click(toggle());
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("comparebuilds-theme")).toBe("dark");

    // dark → auto: the override is cleared — no attribute, no stored value, back
    // to following the OS.
    fireEvent.click(toggle());
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(window.localStorage.getItem("comparebuilds-theme")).toBeNull();

    // Back at auto, the cycle offers the light step again.
    expect(
      screen.getByRole("button", { name: /switch to light/i }),
    ).toBeInTheDocument();
  });

  test("restores a persisted light override on mount", () => {
    window.localStorage.setItem("comparebuilds-theme", "light");

    render(<App />);

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(
      screen.getByRole("button", { name: /switch to dark/i }),
    ).toBeInTheDocument();
  });

  test("treats a legacy stored 'auto' as no override (no attribute)", () => {
    window.localStorage.setItem("comparebuilds-theme", "auto");

    render(<App />);

    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(
      screen.getByRole("button", { name: /switch to light/i }),
    ).toBeInTheDocument();
  });
});

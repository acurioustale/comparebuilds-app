// @vitest-environment jsdom
/**
 * The comparison panels label their builds by the same rule the build-manager
 * slots do (buildOrdinal). The two used to key on different counts — slots vs
 * parsed builds — so a corrupt slot made them disagree. These drive the real
 * store and assert on what each view actually renders.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import MainView from "./MainView.jsx";
import BuildManager from "./BuildManager.jsx";
import { useBuildsStore } from "../store/buildsStore.js";
import { genStrings, UNPARSEABLE_BLOOD } from "../test/buildStrings.js";

const load = async (strings) => {
  for (const s of strings) {
    await act(async () => {
      await useBuildsStore.getState().addBuild(s);
    });
  }
};

beforeEach(() => {
  useBuildsStore.getState().clearAllBuilds();
});
afterEach(() => {
  cleanup();
});

describe("comparison panel labels", () => {
  test("names the two panels A and B", async () => {
    await load(genStrings("death_knight", "blood", 2));
    render(<MainView />);

    expect(
      screen.getAllByText(/Build A — Blood Death Knight/).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/Build B — Blood Death Knight/).length,
    ).toBeGreaterThan(0);
    // The pair is what the panels show — no slot-numbered label leaks in.
    expect(screen.queryByText(/Build 1 — Blood Death Knight/)).toBeNull();
  });

  test("keeps the pair when a third slot fails to parse", async () => {
    const [a, b] = genStrings("death_knight", "blood", 2);
    await load([a, b, UNPARSEABLE_BLOOD]);
    expect(useBuildsStore.getState().parsedBuilds[2]).toBeNull();

    render(<MainView />);

    // Two builds parsed, so the paired diff renders — labelled A/B, not by the
    // three slots behind it.
    expect(
      screen.getAllByText(/Build A — Blood Death Knight/).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/Build B — Blood Death Knight/).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/Build 3 — Blood Death Knight/)).toBeNull();
  });

  test("panels and build-manager slots agree on every name", async () => {
    const [a, b] = genStrings("death_knight", "blood", 2);
    await load([a, b, UNPARSEABLE_BLOOD]);

    render(
      <>
        <BuildManager />
        <MainView />
      </>,
    );

    // Each rendered panel's label is also a slot's label, and the unparsed
    // slot — absent from the comparison — keeps its own number.
    for (const label of ["Build A", "Build B"]) {
      expect(
        screen.getByPlaceholderText(
          new RegExp(`${label} — Blood Death Knight`),
        ),
      ).toBeInTheDocument();
      expect(
        screen.getAllByText(new RegExp(`${label} — Blood Death Knight`)).length,
      ).toBeGreaterThan(0);
    }
    expect(
      screen.getByPlaceholderText(/Build 3 — Blood Death Knight/),
    ).toBeInTheDocument();
  });
});

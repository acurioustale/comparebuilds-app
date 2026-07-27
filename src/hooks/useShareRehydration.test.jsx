// @vitest-environment jsdom
/**
 * Regression coverage for the share-link failure messages. addBuild rejects a
 * build by returning false, not by throwing, so a link whose builds all fail to
 * commit never reaches the catch block — without an explicit branch the user
 * would get a blank interactive tree and no explanation at all.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useShareRehydration } from "./useShareRehydration.js";
import { resolveRoute } from "../lib/route";

vi.mock("../lib/route", () => ({ resolveRoute: vi.fn() }));

const state = {
  addBuild: vi.fn(),
  clearAllBuilds: vi.fn(),
  rehydrateTreeData: vi.fn(),
  setBuildNames: vi.fn(),
  preloadSpec: vi.fn(),
  setSharedLayoutHash: vi.fn(),
  buildStrings: [],
  parsedBuilds: [],
};

vi.mock("../store/buildsStore", () => {
  const useBuildsStore = (selector) => selector(state);
  useBuildsStore.getState = () => state;
  return { useBuildsStore };
});

const payload = { builds: ["aaa", "bbb"], labels: ["A", "B"] };

const mockFetch = (body) =>
  vi.fn().mockResolvedValue({ ok: true, json: async () => body });

beforeEach(() => {
  resolveRoute.mockReturnValue({ kind: "share", id: "abcd1234" });
  state.parsedBuilds = [];
  state.buildStrings = [];
  history.replaceState(null, "", "/#abcd1234");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useShareRehydration share failures", () => {
  test("reports a link whose builds all fail to load, and keeps the hash", async () => {
    state.addBuild.mockResolvedValue(false);
    vi.stubGlobal("fetch", mockFetch(payload));

    const { result } = renderHook(() => useShareRehydration());

    await waitFor(() => expect(result.current.shareError).toBeTruthy());
    expect(result.current.shareError).toMatch(/None of the builds/);
    // Nothing parsed, so the id stays for a reload to retry.
    expect(window.location.hash).toBe("#abcd1234");
  });

  test("reports a partial load", async () => {
    state.addBuild.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    state.parsedBuilds = [{}];
    vi.stubGlobal("fetch", mockFetch(payload));

    const { result } = renderHook(() => useShareRehydration());

    await waitFor(() => expect(result.current.shareError).toBeTruthy());
    expect(result.current.shareError).toMatch(/1 of 2 builds/);
  });

  test("stays silent when every build lands", async () => {
    state.addBuild.mockResolvedValue(true);
    state.parsedBuilds = [{}, {}];
    vi.stubGlobal("fetch", mockFetch(payload));

    const { result } = renderHook(() => useShareRehydration());

    await waitFor(() => expect(state.addBuild).toHaveBeenCalledTimes(2));
    expect(result.current.shareError).toBeNull();
  });
});

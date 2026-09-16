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
  captureSession: vi.fn(() => ({ snapshot: true })),
  restoreSession: vi.fn(),
  buildStrings: [],
  parsedBuilds: [],
  error: null,
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
  state.error = null;
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

  test("puts the local session back when no build in the link loads", async () => {
    // Regression: clearAllBuilds ran on a merely *structurally* valid payload,
    // before any build had committed, and persist overwrote localStorage the
    // moment the store emptied. A link whose builds all failed therefore
    // destroyed the user's own saved builds for good — restoreLocalSession was
    // unreachable on this path.
    state.addBuild.mockResolvedValue(false);
    vi.stubGlobal("fetch", mockFetch(payload));

    const { result } = renderHook(() => useShareRehydration());

    await waitFor(() => expect(result.current.shareError).toBeTruthy());
    // The session was captured before the clear and restored after the failure.
    expect(state.captureSession).toHaveBeenCalled();
    expect(state.restoreSession).toHaveBeenCalledWith({ snapshot: true });
    expect(state.captureSession.mock.invocationCallOrder[0]).toBeLessThan(
      state.clearAllBuilds.mock.invocationCallOrder[0],
    );
    expect(state.clearAllBuilds.mock.invocationCallOrder[0]).toBeLessThan(
      state.restoreSession.mock.invocationCallOrder[0],
    );
    // And the failed share's layout hash is dropped with it, so the restored
    // session isn't flagged as being from an earlier talent revision.
    expect(state.setSharedLayoutHash).toHaveBeenLastCalledWith(null);
    // The restored session's derived state is rebuilt, as on the local route.
    expect(state.rehydrateTreeData).toHaveBeenCalled();
  });

  test("blames the connection, not the layout, when tree data failed to load", async () => {
    // A transient class-data failure (a hashed chunk 404ing right after a
    // deploy, or a dropped connection) also lands zero builds. Reporting it as
    // an outdated layout contradicts the store's own error on the slot and
    // points the user away from the reload that would actually fix it.
    state.addBuild.mockResolvedValue(false);
    state.error = "Failed to load tree data: fetch failed";
    vi.stubGlobal("fetch", mockFetch(payload));

    const { result } = renderHook(() => useShareRehydration());

    await waitFor(() => expect(result.current.shareError).toBeTruthy());
    expect(result.current.shareError).toMatch(/reload to try again/);
    expect(result.current.shareError).not.toMatch(/older version/);
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

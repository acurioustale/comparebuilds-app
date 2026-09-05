// @vitest-environment jsdom
/**
 * Regression coverage for the copy-state reset timers. They are scheduled in an
 * async finally that runs after the share promise settles — which can be after
 * the component unmounts. The unmount cleanup must not leave an orphan timer
 * that fires setState on a removed component.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useShareActions } from "./useShareActions.js";
import { createServerShare } from "../lib/shareLink.js";
import { generateSimcProfileset } from "../lib/simcProfile.js";

vi.mock("../lib/shareLink.js", () => ({ createServerShare: vi.fn() }));
vi.mock("../lib/simcProfile.js", () => ({ generateSimcProfileset: vi.fn() }));

const baseProps = {
  classId: 6,
  specId: 250,
  buildStrings: ["x"],
  buildNames: [""],
  classDisplayName: "Death Knight",
  specDisplayName: "Blood",
  treeData: {},
  parsedBuilds: [null],
  layoutHash: "h",
};

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useShareActions copy-link reset timer", () => {
  test("does not schedule a reset timer when unmounted before the share resolves", async () => {
    let resolveShare;
    createServerShare.mockReturnValue(
      new Promise((r) => {
        resolveShare = r;
      }),
    );
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const { result, unmount } = renderHook(() => useShareActions(baseProps));

    // Kick off the copy; the share promise stays pending.
    act(() => {
      result.current.handleCopyLink();
    });
    // The component is removed before the share settles.
    unmount();

    await act(async () => {
      resolveShare({ id: "abc123xy" });
      await flush();
    });

    // No 2s reset timer was scheduled after unmount — nothing would clear it.
    const resetTimers = setTimeoutSpy.mock.calls.filter(([, d]) => d === 2000);
    expect(resetTimers).toHaveLength(0);
  });

  test("schedules the reset timer on the happy path while still mounted", async () => {
    createServerShare.mockResolvedValue({ id: "abc123xy" });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const { result } = renderHook(() => useShareActions(baseProps));

    await act(async () => {
      await result.current.handleCopyLink();
      await flush();
    });

    expect(result.current.copyState).toBe("copied");
    const resetTimers = setTimeoutSpy.mock.calls.filter(([, d]) => d === 2000);
    expect(resetTimers).toHaveLength(1);
  });
});

describe("useShareActions copy-link error reporting", () => {
  test("keeps the API's own message so the UI can show more than 'Failed'", async () => {
    createServerShare.mockRejectedValue(
      new Error("Could not generate a unique share ID"),
    );

    const { result } = renderHook(() => useShareActions(baseProps));

    await act(async () => {
      result.current.handleCopyLink();
      await flush();
    });

    expect(result.current.copyState).toBe("error");
    expect(result.current.copyError).toBe(
      "Could not generate a unique share ID",
    );
  });

  test("reports a rejected clipboard write distinctly from a server refusal", async () => {
    createServerShare.mockResolvedValue({ id: "abcdefgh" });
    navigator.clipboard.writeText.mockRejectedValue(
      new Error("Write permission denied."),
    );

    const { result } = renderHook(() => useShareActions(baseProps));

    await act(async () => {
      result.current.handleCopyLink();
      await flush();
    });

    expect(result.current.copyError).toBe("Write permission denied.");
  });

  test("falls back to a generic message when the failure carries none", async () => {
    createServerShare.mockRejectedValue(new Error(""));

    const { result } = renderHook(() => useShareActions(baseProps));

    await act(async () => {
      result.current.handleCopyLink();
      await flush();
    });

    expect(result.current.copyError).toBe("Something went wrong.");
  });

  test("clears the previous error when a later attempt is started", async () => {
    createServerShare.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useShareActions(baseProps));

    await act(async () => {
      result.current.handleCopyLink();
      await flush();
    });
    expect(result.current.copyError).toBe("boom");

    // The label resets to idle after 2s; only then does the guard let a retry
    // through. Advance past it, then succeed.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2100));
    });
    createServerShare.mockResolvedValue({ id: "abcdefgh" });

    await act(async () => {
      result.current.handleCopyLink();
      await flush();
    });

    expect(result.current.copyState).toBe("copied");
    expect(result.current.copyError).toBeNull();
  });
});

describe("useShareActions simc-export error reporting", () => {
  test("keeps the reason a profileset could not be generated", async () => {
    generateSimcProfileset.mockImplementation(() => {
      throw new Error("No parsed builds to export.");
    });

    const { result } = renderHook(() => useShareActions(baseProps));

    await act(async () => {
      result.current.handleCopySimc();
      await flush();
    });

    expect(result.current.simcState).toBe("error");
    expect(result.current.simcError).toBe("No parsed builds to export.");
  });

  test("reports a rejected clipboard write distinctly from a generation failure", async () => {
    generateSimcProfileset.mockReturnValue("profileset text");
    navigator.clipboard.writeText.mockRejectedValue(
      new Error("Write permission denied."),
    );

    const { result } = renderHook(() => useShareActions(baseProps));

    await act(async () => {
      result.current.handleCopySimc();
      await flush();
    });

    expect(result.current.simcError).toBe("Write permission denied.");
  });

  test("clears the previous error when a later export is started", async () => {
    generateSimcProfileset.mockImplementation(() => {
      throw new Error("boom");
    });
    const { result } = renderHook(() => useShareActions(baseProps));

    await act(async () => {
      result.current.handleCopySimc();
      await flush();
    });
    expect(result.current.simcError).toBe("boom");

    // The guard only lets a retry through once the 2s label reset has fired.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2100));
    });
    generateSimcProfileset.mockReturnValue("profileset text");

    await act(async () => {
      result.current.handleCopySimc();
      await flush();
    });

    expect(result.current.simcState).toBe("copied");
    expect(result.current.simcError).toBeNull();
  });

  test("a share failure does not present itself as a simc failure", async () => {
    createServerShare.mockRejectedValue(new Error("server said no"));

    const { result } = renderHook(() => useShareActions(baseProps));

    await act(async () => {
      result.current.handleCopyLink();
      await flush();
    });

    expect(result.current.copyError).toBe("server said no");
    expect(result.current.simcError).toBeNull();
  });
});

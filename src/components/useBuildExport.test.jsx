// @vitest-environment jsdom
/**
 * useBuildExport — the interactive tree's copy/export hook.
 *
 * Regression suite for the clipboard-gated export bug: handleExport used to
 * await navigator.clipboard.writeText BEFORE addBuild, so a denied clipboard
 * (permissions policy, non-secure origin) aborted committing a perfectly
 * valid build to the comparison. The copy is a courtesy on top of the real
 * work — it now runs after a successful add and its failure is swallowed.
 */

import { describe, test, expect, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useBuildExport } from "./useBuildExport";

const BUILD = "AAAABBBB";

function setClipboard(value) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value,
  });
}

function renderExport(overrides = {}) {
  const props = {
    currentBuildString: BUILD,
    invalidNodeIdsSize: 0,
    hasUserSelection: true,
    addBuild: vi.fn(async () => true),
    replaceBuild: vi.fn(async () => true),
    editingIndex: null,
    sessionGen: 0,
    finishAddingBuild: vi.fn(),
    ...overrides,
  };
  return {
    props,
    ...renderHook((p) => useBuildExport(p), { initialProps: props }),
  };
}

afterEach(() => {
  setClipboard(undefined);
  vi.restoreAllMocks();
});

describe("handleExport", () => {
  test("adds the build even when the clipboard write is denied", async () => {
    setClipboard({
      writeText: vi.fn().mockRejectedValue(new Error("denied")),
    });
    const { props, result } = renderExport();

    await act(() => result.current.handleExport());

    expect(props.addBuild).toHaveBeenCalledWith(BUILD);
    expect(result.current.exportState).toBe("done");
  });

  test("adds the build even when the Clipboard API is entirely absent", async () => {
    // jsdom: navigator.clipboard undefined AND document.execCommand missing,
    // so even the execCommand fallback fails — the add must still land.
    setClipboard(undefined);
    const { props, result } = renderExport();

    await act(() => result.current.handleExport());

    expect(props.addBuild).toHaveBeenCalledWith(BUILD);
    expect(result.current.exportState).toBe("done");
  });

  test("a rejected build still surfaces as a failure", async () => {
    setClipboard({ writeText: vi.fn(async () => {}) });
    const { props, result } = renderExport({
      addBuild: vi.fn(async () => false),
    });

    await act(() => result.current.handleExport());

    expect(result.current.exportState).toBe("error");
    expect(props.finishAddingBuild).not.toHaveBeenCalled();
  });

  test("copies as a courtesy after a successful add", async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    const { props, result } = renderExport();

    await act(() => result.current.handleExport());

    expect(writeText).toHaveBeenCalledWith(BUILD);
    expect(props.addBuild).toHaveBeenCalledWith(BUILD);
    // The add committed before the copy was attempted.
    expect(props.addBuild.mock.invocationCallOrder[0]).toBeLessThan(
      writeText.mock.invocationCallOrder[0],
    );
  });
});

describe("post-export countdown", () => {
  test("closes the editor when no new session started", async () => {
    vi.useFakeTimers();
    setClipboard({ writeText: vi.fn(async () => {}) });
    const { props, result } = renderExport();

    await act(() => result.current.handleExport());
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(props.finishAddingBuild).toHaveBeenCalledTimes(1);
    expect(result.current.exportState).toBe("idle");
    vi.useRealTimers();
  });

  // Clicking Edit within the 2 s "Copied & added!" window opens a new session
  // and seeds the calculator with that build's selection. The countdown armed
  // by the previous export must not then fire finishAddingBuild() and wipe it.
  test("a new session cancels the pending finishAddingBuild", async () => {
    vi.useFakeTimers();
    setClipboard({ writeText: vi.fn(async () => {}) });
    const { props, result, rerender } = renderExport();

    await act(() => result.current.handleExport());
    expect(result.current.exportState).toBe("done");

    rerender({ ...props, sessionGen: 1, editingIndex: 0 });
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(props.finishAddingBuild).not.toHaveBeenCalled();
    expect(result.current.exportState).toBe("idle");
    vi.useRealTimers();
  });
});

describe("handleCopyString", () => {
  test("falls back to execCommand when the Clipboard API is unavailable", async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn(() => true);
    const { result } = renderExport();

    await act(() => result.current.handleCopyString());

    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(result.current.copyState).toBe("done");
    delete document.execCommand;
  });
});

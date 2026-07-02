// @vitest-environment jsdom
/**
 * Regression test for the FilledSlot copy-confirmation timer: a rapid second
 * copy must keep the "Copied!" state for its own full duration, not have it cut
 * short by the first copy's still-pending reset timer.
 */

import { describe, test, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
} from "@testing-library/react";
import { FilledSlot } from "./BuildManagerSlots.jsx";

const noop = () => {};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderSlot() {
  render(
    <FilledSlot
      index={0}
      total={1}
      name=""
      label="Build 1"
      summary="Blood Death Knight"
      value="ABCDEF"
      parsed={{}}
      loading={false}
      onRemove={noop}
      onRename={noop}
      onEdit={noop}
    />,
  );
  return screen.getByLabelText("Copy build string");
}

describe("FilledSlot copy confirmation", () => {
  test("a second copy holds the confirmation for its own full 1.5s", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue();
    Object.assign(navigator, { clipboard: { writeText } });

    const btn = renderSlot();
    expect(btn.textContent).toBe("⧉");

    // First copy → confirmation shows.
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(btn.textContent).toBe("✓");

    // 1s later (first reset still pending, due at 1.5s), copy again.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(btn.textContent).toBe("✓");

    // Advance past the first timer's original 1.5s deadline. If it were still
    // live it would fire here and clear the confirmation; the fix clears it, so
    // the second copy's confirmation must survive.
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    expect(btn.textContent).toBe("✓");

    // Reaching the second copy's own 1.5s deadline finally resets it.
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    expect(btn.textContent).toBe("⧉");
  });
});

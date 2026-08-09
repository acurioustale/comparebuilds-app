// @vitest-environment jsdom
/**
 * Pins the Testing Library async deadline configured in setup.js.
 *
 * The findBy queries and waitFor do NOT honour Vitest's testTimeout — they
 * carry their own, defaulting to 1s. The suite has 62 such waits across the
 * component files, and a worker starved past that deadline fails with an
 * "Unable to find an element" assertion in a run that finishes in seconds,
 * which reads as a real regression rather than a busy machine. Losing the
 * configure() in setup.js would silently reopen that, and only on a loaded machine.
 */

import { describe, test, expect } from "vitest";
import { getConfig } from "@testing-library/react";

describe("testing-library async deadline", () => {
  test("is raised well above the 1s default and stays under testTimeout", () => {
    const { asyncUtilTimeout } = getConfig();

    expect(asyncUtilTimeout).toBeGreaterThanOrEqual(10_000);
    // Must stay below Vitest's testTimeout (30s in vite.config.js) so a stuck
    // wait fails here first, with the query and DOM dump that make it
    // debuggable, rather than as a bare test timeout.
    expect(asyncUtilTimeout).toBeLessThan(30_000);
  });
});

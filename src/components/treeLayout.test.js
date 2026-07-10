/**
 * Tests for the shared panel-geometry helpers. Pure math, no DOM.
 */

import { describe, test } from "vitest";
import assert from "node:assert/strict";
import {
  panelBounds,
  choiceRowWidth,
  PAD,
  CELL,
  CHOICE_ICON,
  CHOICE_GAP,
} from "./treeLayout.js";

describe("panelBounds", () => {
  test("computes bounds from node positions", () => {
    const b = panelBounds([
      { posX: 1, posY: 2 },
      { posX: 4, posY: 6 },
    ]);
    assert.strictEqual(b.minX, 1);
    assert.strictEqual(b.minY, 2);
    assert.strictEqual(b.W, (4 - 1) * CELL + PAD * 2);
    assert.strictEqual(b.H, (6 - 2) * CELL + PAD * 2);
  });

  test("returns a finite padding box for an empty panel (no NaN/Infinity)", () => {
    const b = panelBounds([]);
    assert.deepStrictEqual(b, { minX: 0, minY: 0, W: PAD * 2, H: PAD * 2 });
    for (const v of Object.values(b)) assert.ok(Number.isFinite(v));
  });
});

describe("choiceRowWidth", () => {
  // The schema permits 2-4 options (the wire field encodes picks 0-3); the row
  // width must follow the option count so a 3/4-option node isn't rendered
  // with a two-icon width (mis-centred, undersized overlays).
  const withChoices = (n) => ({
    choices: Array.from({ length: n }, () => ({})),
  });

  test("derives the row width from the option count", () => {
    assert.strictEqual(
      choiceRowWidth(withChoices(2)),
      CHOICE_ICON * 2 + CHOICE_GAP,
    );
    assert.strictEqual(
      choiceRowWidth(withChoices(3)),
      CHOICE_ICON * 3 + CHOICE_GAP * 2,
    );
    assert.strictEqual(
      choiceRowWidth(withChoices(4)),
      CHOICE_ICON * 4 + CHOICE_GAP * 3,
    );
  });

  test("falls back to the two-option width for a malformed node", () => {
    assert.strictEqual(
      choiceRowWidth({ choices: null }),
      CHOICE_ICON * 2 + CHOICE_GAP,
    );
  });
});

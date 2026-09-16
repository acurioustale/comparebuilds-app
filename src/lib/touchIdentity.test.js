import { describe, it, expect } from "vitest";
import { touchById, ownTouchLifted, ownTouches } from "./touchIdentity.js";

const t = (identifier, x = 0, y = 0) => ({
  identifier,
  clientX: x,
  clientY: y,
});

describe("touchById", () => {
  it("finds the touch with the given identifier", () => {
    expect(touchById([t(1), t(2), t(3)], 2)).toEqual(t(2));
  });

  it("matches identifier 0, which is a real first finger", () => {
    expect(touchById([t(0), t(1)], 0)).toEqual(t(0));
  });

  it("returns undefined when the finger is not in the list", () => {
    expect(touchById([t(1), t(2)], 9)).toBeUndefined();
  });

  it("returns undefined for a missing list or id", () => {
    expect(touchById(undefined, 1)).toBeUndefined();
    expect(touchById([t(1)], null)).toBeUndefined();
    expect(touchById([t(1)], undefined)).toBeUndefined();
  });
});

describe("ownTouchLifted", () => {
  it("is true when the gesture's own finger is among the lifted touches", () => {
    const e = { changedTouches: [t(2)] };
    expect(ownTouchLifted(e, { id: 2 })).toBe(true);
  });

  it("is false when some other finger lifted", () => {
    // The defect this exists for: a second finger's lift used to complete the
    // first finger's pending gesture — spending a point, or closing a tooltip
    // that was still being held open.
    const e = { changedTouches: [t(2)] };
    expect(ownTouchLifted(e, { id: 1 })).toBe(false);
  });

  it("is false when there is no gesture in progress", () => {
    expect(ownTouchLifted({ changedTouches: [t(1)] }, null)).toBe(false);
    expect(ownTouchLifted({ changedTouches: [t(1)] }, undefined)).toBe(false);
  });

  it("falls back to true for a gesture or event carrying no identity", () => {
    // Synthetic events and test doubles have no touch lists; those callers keep
    // the single-touch behaviour they had before identity was tracked.
    expect(ownTouchLifted(undefined, { id: 1 })).toBe(true);
    expect(ownTouchLifted({}, { id: 1 })).toBe(true);
    expect(ownTouchLifted({ changedTouches: [t(2)] }, { id: undefined })).toBe(
      true,
    );
  });
});

describe("ownTouches", () => {
  it("prefers the touches scoped to this element", () => {
    // A finger resting elsewhere on the screen is in `touches` but not in
    // `targetTouches`; reading the former made every tap here a no-op.
    const e = { touches: [t(1), t(2)], targetTouches: [t(2)] };
    expect(ownTouches(e)).toHaveLength(1);
  });

  it("falls back to touches when targetTouches is absent or empty", () => {
    expect(ownTouches({ touches: [t(1)] })).toHaveLength(1);
    expect(ownTouches({ touches: [t(1)], targetTouches: [] })).toHaveLength(1);
  });
});

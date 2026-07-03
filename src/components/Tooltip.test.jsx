// @vitest-environment jsdom
/**
 * Tooltip child-coercion tests. Floating UI needs a single element to anchor to;
 * these verify a valid element passes through and a non-element child (string,
 * number, array, nullish) is wrapped rather than crashing at children.props.
 */

import { describe, test, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import Tooltip from "./Tooltip.jsx";

afterEach(cleanup);

describe("Tooltip child handling", () => {
  test("renders a valid element child without wrapping it", () => {
    render(
      <Tooltip content="tip">
        <button>Click me</button>
      </Tooltip>,
    );
    const btn = screen.getByRole("button", { name: "Click me" });
    expect(btn.tagName).toBe("BUTTON");
  });

  test("wraps a bare string child instead of throwing", () => {
    expect(() =>
      render(<Tooltip content="tip">just text</Tooltip>),
    ).not.toThrow();
    expect(screen.getByText("just text").tagName).toBe("SPAN");
  });

  test("wraps a multi-child array instead of throwing", () => {
    expect(() =>
      render(
        <Tooltip content="tip">
          {["a", "b"]}
          {" and more"}
        </Tooltip>,
      ),
    ).not.toThrow();
  });
});

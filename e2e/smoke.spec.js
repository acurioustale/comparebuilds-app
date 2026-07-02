import { test, expect } from "@playwright/test";

// These cover only what needs a real layout engine and computed styles — the
// behaviour the jsdom component suites can't verify. The pure logic (decode,
// spend rules, diff/heatmap) is unit-tested in src/lib; this is the in-browser
// layer: the light-dark() repaint and the lazy class-data import + render path.

// A real in-game Guardian Druid loadout string (the ground-truth fixture from
// src/lib/buildFixtures.test.js). Pasting it exercises the full decode → lazy
// class-data load → tree-render pipeline against the shipped data.
const GUARDIAN_DRUID =
  "CgGA8cL7tpvige+kkmGM9zUPWDAAAAAAAAAAAgZmZmFzMjZWMLm5BmZZZgZbGGNRmZWMzMzsMzMMAAAAAGYsYGYZbmBjZZAMFAAAYDzAYxYYgZxyGgZGAA";

test("renders the build manager on first load", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Compare Builds" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Theme:/ })).toBeVisible();
  await expect(
    page.getByPlaceholder("Paste build string…").first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Start from scratch/ }),
  ).toBeVisible();
});

test("the theme toggle repaints the page background", async ({ page }) => {
  // Fix the OS preference so the three-way cycle order is deterministic: off a
  // dark OS the first click forces light, the second dark (nextTheme derives the
  // order from the OS preference).
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");

  const toggle = page.getByRole("button", { name: /^Theme:/ });
  const bodyBg = () =>
    page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  // Forcing the scheme resolves the light-dark() --wow-body-bg token to a
  // different colour each way — something jsdom has no computed color-scheme to
  // do. Wait for the React effect to write data-theme before reading the paint.
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const lightBg = await bodyBg();

  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const darkBg = await bodyBg();

  expect(lightBg).not.toBe(darkBg);
});

test("Start from scratch opens the interactive calculator", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Start from scratch/ }).click();

  // The class JSON is a lazy Vite chunk; once it resolves the interactive tree
  // renders its talent nodes.
  await expect(page.locator(".tnode").first()).toBeVisible({ timeout: 15_000 });
  expect(await page.locator(".tnode").count()).toBeGreaterThan(10);
});

test("pasting a valid build string renders its tree", async ({ page }) => {
  await page.goto("/");
  const input = page.getByPlaceholder("Paste build string…").first();
  await input.fill(GUARDIAN_DRUID);
  await input.press("Enter");

  // A parsed build shows its edit affordance (only rendered once parsing
  // succeeds) and draws the read-only single-build tree. That view's nodes are
  // non-interactive (no .tnode class), so assert on the tree's section panels.
  await expect(page.getByRole("button", { name: "Edit build 1" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator(".wow-subpanel").first()).toBeVisible();
});

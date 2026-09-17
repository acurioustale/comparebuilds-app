import { test } from "vitest";
import assert from "node:assert/strict";

import { readShellArray, isLiteralPath } from "./shell-arrays.mjs";

// The deploy-set guard reads deploy.sh's own arrays instead of keeping a copy of
// them, so a parser that silently reads a PARTIAL list is worse than none: the
// guard would still report success while classifying fewer files than ship. Every
// shape it cannot read whole must therefore come back as an error, never as a
// best-effort subset.

// --- readShellArray ---------------------------------------------------------

test("readShellArray reads a one-line array literal", () => {
  const result = readShellArray(
    `set -euo pipefail\nAPI_ASSETS=(api/share.php api/lib api/fonts)\n`,
    "API_ASSETS",
  );
  assert.deepEqual(result, {
    ok: true,
    entries: ["api/share.php", "api/lib", "api/fonts"],
  });
});

test("readShellArray tolerates leading indentation and inner whitespace", () => {
  const result = readShellArray(`\tA=(  one   two\t three )\n`, "A");
  assert.deepEqual(result.entries, ["one", "two", "three"]);
});

test("readShellArray strips an inline comment", () => {
  const result = readShellArray(`A=(one two) # three\n`, "A");
  assert.deepEqual(result.entries, ["one", "two"]);
});

test("readShellArray ignores a commented-out example above the real array", () => {
  // deploy.sh documents its arrays in prose directly above them; an example in
  // that comment must not be mistaken for the list the deploy stages.
  const result = readShellArray(`# A=(wrong example)\nA=(right)\n`, "A");
  assert.deepEqual(result.entries, ["right"]);
});

test("readShellArray reports a missing array rather than an empty one", () => {
  // An empty entry list would pass every downstream check vacuously.
  assert.deepEqual(readShellArray(`B=(one)\n`, "A"), {
    ok: false,
    reason: "missing",
  });
});

test("readShellArray refuses a second assignment", () => {
  assert.deepEqual(readShellArray(`A=(one)\nA=(two)\n`, "A"), {
    ok: false,
    reason: "multiple",
  });
});

test("readShellArray refuses a += append", () => {
  assert.deepEqual(readShellArray(`A=(one)\nA+=(two)\n`, "A"), {
    ok: false,
    reason: "multiple",
  });
});

test("readShellArray does not match a longer variable ending in the name", () => {
  // `API_ASSETS` must not be read out of `EXTRA_API_ASSETS=(...)`.
  assert.deepEqual(readShellArray(`XA=(wrong)\n`, "A"), {
    ok: false,
    reason: "missing",
  });
});

test("readShellArray refuses a multi-line literal rather than guessing at it", () => {
  // Reported apart from `missing` so the message can say what is actually wrong.
  assert.deepEqual(readShellArray(`A=(\n  one\n  two\n)\n`, "A"), {
    ok: false,
    reason: "multiline",
  });
});

test("readShellArray does not read a partial list past a stray parenthesis", () => {
  // The fail-open this helper exists to prevent: a `)` below the array (here in
  // a later line's comment) must not let the match run on and pick up a set that
  // is neither the real one nor obviously wrong.
  const result = readShellArray(
    `A=(\n  one # note (see above)\n  two\n)\n`,
    "A",
  );
  assert.equal(result.ok, false);
});

// --- isLiteralPath ----------------------------------------------------------

test("isLiteralPath accepts the plain paths the deploy set uses", () => {
  for (const entry of [
    "api/share.php",
    "api/lib",
    "api/current_layouts.json",
    "api/fonts/DejaVuSans-Bold.ttf",
  ]) {
    assert.equal(isLiteralPath(entry), true, entry);
  }
});

test("isLiteralPath rejects glob and pathspec magic", () => {
  // These resolve one way as a git pathspec against HEAD and another way as the
  // filesystem path the guard checks, so the two would stop meaning the same.
  for (const entry of [
    "api/*.php",
    "api/lib/?ate.php",
    "api/[lc]ib",
    "api/li\\b",
    ":(glob)api/**/*.php",
    "!api/config.php",
    "api/../api/share.php",
  ]) {
    assert.equal(isLiteralPath(entry), false, entry);
  }
});

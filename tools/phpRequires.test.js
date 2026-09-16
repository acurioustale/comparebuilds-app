import { test } from "vitest";
import assert from "node:assert/strict";

import { phpRequires, resolveRequire } from "./php-requires.mjs";

// The deploy-set guard trusts this scanner to see every runtime dependency of a
// shipped PHP file: one it misses is a file `rsync --delete` removes server-side
// with nothing in the gate to notice. So a require it cannot resolve must be
// counted as unresolved (fail closed), never quietly skipped.

// --- phpRequires ------------------------------------------------------------

test("phpRequires reads a __DIR__-relative require_once", () => {
  const { targets, unresolved } = phpRequires(
    `<?php\nrequire_once __DIR__ . '/lib/RateLimiter.php';\n`,
  );
  assert.deepEqual(targets, ["/lib/RateLimiter.php"]);
  assert.equal(unresolved, 0);
});

test("phpRequires reads every require/include spelling and both quote styles", () => {
  const { targets, unresolved } = phpRequires(`<?php
require __DIR__ . '/a.php';
require_once __DIR__ . "/b.php";
include __DIR__ . '/c.php';
include_once(__DIR__ . '/d.php');
`);
  assert.deepEqual(targets, ["/a.php", "/b.php", "/c.php", "/d.php"]);
  assert.equal(unresolved, 0);
});

test("phpRequires tolerates the whitespace a formatter may introduce", () => {
  const { targets, unresolved } = phpRequires(
    `<?php\nrequire_once   __DIR__\n  . '/../share.php'  ;\n`,
  );
  assert.deepEqual(targets, ["/../share.php"]);
  assert.equal(unresolved, 0);
});

test("phpRequires counts a dynamic require as unresolved rather than skipping it", () => {
  // A variable path cannot be resolved statically. Reporting zero targets and
  // zero unresolved would assure the caller of a dependency never checked.
  const { targets, unresolved } = phpRequires(
    `<?php\n$name = 'x';\nrequire_once __DIR__ . '/' . $name . '.php';\n`,
  );
  assert.deepEqual(targets, []);
  assert.equal(unresolved, 1);
});

test("phpRequires counts an interpolating double-quoted path as unresolved", () => {
  // `"$dir/x.php"` interpolates in PHP, so the literal text is not the path.
  const { targets, unresolved } = phpRequires(
    `<?php\nrequire_once __DIR__ . "/$sub/x.php";\n`,
  );
  assert.deepEqual(targets, []);
  assert.equal(unresolved, 1);
});

test("phpRequires ignores a require inside a line or block comment", () => {
  const { targets, unresolved } = phpRequires(`<?php
// require_once __DIR__ . '/old.php';
# require_once __DIR__ . '/older.php';
/* require_once __DIR__ . '/oldest.php'; */
require_once __DIR__ . '/live.php';
`);
  assert.deepEqual(targets, ["/live.php"]);
  assert.equal(unresolved, 0);
});

test("phpRequires is not thrown off by a // inside a string literal", () => {
  // Stripping from `//` blindly would swallow the rest of the line — and with it
  // a real require declared after a URL on the same line.
  const { targets, unresolved } = phpRequires(
    `<?php\n$u = 'https://example.test/x'; require_once __DIR__ . '/live.php';\n`,
  );
  assert.deepEqual(targets, ["/live.php"]);
  assert.equal(unresolved, 0);
});

test("phpRequires does not match the variable $required", () => {
  // api/og.php has one; a loose word match would report a phantom unresolved
  // require and fail the gate on correct code.
  const { targets, unresolved } = phpRequires(
    `<?php\n$required = 8 * 1024 * 1024;\nif ($val > 0 && $val < $required) {}\n`,
  );
  assert.deepEqual(targets, []);
  assert.equal(unresolved, 0);
});

test("phpRequires returns nothing for a file with no requires", () => {
  const { targets, unresolved } = phpRequires(`<?php\nfunction f() {}\n`);
  assert.deepEqual(targets, []);
  assert.equal(unresolved, 0);
});

// --- resolveRequire ---------------------------------------------------------

test("resolveRequire resolves a target against the requiring file's directory", () => {
  assert.equal(
    resolveRequire("api", "/lib/RateLimiter.php"),
    "api/lib/RateLimiter.php",
  );
});

test("resolveRequire collapses .. segments", () => {
  assert.equal(resolveRequire("api/cron", "/../share.php"), "api/share.php");
  assert.equal(resolveRequire("api/cron", "/../../api/og.php"), "api/og.php");
});

test("resolveRequire keeps a climb above the repo root visible", () => {
  // config.php lives one level above the web root on purpose; the guard tells it
  // apart from an in-tree path by the leading "../", so that must survive.
  assert.equal(resolveRequire("api", "/../../config.php"), "../config.php");
  assert.equal(
    resolveRequire("api/cron", "/../../../config.php"),
    "../config.php",
  );
});

test("resolveRequire ignores empty and . segments", () => {
  assert.equal(resolveRequire("api", "/./lib//x.php"), "api/lib/x.php");
});

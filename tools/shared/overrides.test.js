import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withoutOverride,
  advisorySummary,
  report,
  isAdvisoryFailure,
} from "./overrides.mjs";

test("withoutOverride drops the named entry and keeps the rest", () => {
  const pkg = {
    name: "site",
    overrides: { "markdown-it": "^14.2.0", "smol-toml": "^1.7.1" },
  };
  assert.deepEqual(withoutOverride(pkg, "markdown-it"), {
    name: "site",
    overrides: { "smol-toml": "^1.7.1" },
  });
});

test("withoutOverride does not mutate the manifest it is given", () => {
  // The check loops over every override, so a mutating trim would make each
  // pass inherit the last one's removal and audit the wrong tree.
  const pkg = { overrides: { a: "1", b: "2" } };
  withoutOverride(pkg, "a");
  assert.deepEqual(pkg.overrides, { a: "1", b: "2" });
});

test("withoutOverride removes the overrides key when the entry was the last", () => {
  // npm reads a declared-but-empty `overrides` differently from an absent one,
  // and the tree we mean to test is the one with the override gone.
  const trimmed = withoutOverride({ name: "site", overrides: { a: "1" } }, "a");
  assert.equal("overrides" in trimmed, false);
  assert.deepEqual(trimmed, { name: "site" });
});

test("withoutOverride keeps the rest of the manifest, dependencies included", () => {
  // The trimmed manifest is what gets resolved, so dropping `dependencies`
  // would audit an empty runtime tree and call every override stale.
  const pkg = {
    name: "app",
    dependencies: { react: "^19.0.0" },
    devDependencies: { vitest: "^3.0.0" },
    overrides: { a: "1" },
  };
  assert.deepEqual(withoutOverride(pkg, "a"), {
    name: "app",
    dependencies: { react: "^19.0.0" },
    devDependencies: { vitest: "^3.0.0" },
  });
});

test("withoutOverride tolerates a manifest with no overrides at all", () => {
  assert.deepEqual(withoutOverride({ name: "site" }, "a"), { name: "site" });
});

test("advisorySummary returns npm's count line, trimmed", () => {
  const output = "\nfixed 0 of 3\n\n2 high severity vulnerabilities  \n";
  assert.equal(advisorySummary(output), "2 high severity vulnerabilities");
});

test("advisorySummary matches the singular npm prints for one advisory", () => {
  assert.equal(
    advisorySummary("1 moderate severity vulnerability"),
    "1 moderate severity vulnerability",
  );
});

test("advisorySummary reads the count line whatever its case", () => {
  assert.equal(
    advisorySummary("FOUND 2 VULNERABILITIES"),
    "FOUND 2 VULNERABILITIES",
  );
});

test("advisorySummary skips the report's 'vulnerable versions' prose", () => {
  // npm's per-advisory block says "Depends on vulnerable versions of x" above
  // the count. The stem is "vulnerabilit", so that line is not a false match.
  const output = [
    "# npm audit report",
    "",
    "smol-toml  <=1.7.0",
    "  markdownlint-cli2  >=0.22.0",
    "  Depends on vulnerable versions of smol-toml",
    "",
    "2 high severity vulnerabilities",
  ].join("\n");
  assert.equal(advisorySummary(output), "2 high severity vulnerabilities");
});

test("advisorySummary is undefined when no line states a count", () => {
  assert.equal(advisorySummary("up to date, audited 1 package"), undefined);
});

test("report calls an override stale when its tree audits clean", () => {
  const out = report([{ name: "markdown-it", advisories: null }]);
  assert.match(out, /markdown-it: STALE - the tree is clean without it\./);
  assert.match(out, /Remove this override from package\.json/);
  assert.match(out, /markdown-it\.$/);
});

test("report quotes the remaining advisories for a load-bearing override", () => {
  const out = report([
    { name: "smol-toml", advisories: "\n2 high severity vulnerabilities\n" },
  ]);
  assert.match(out, /smol-toml: still load-bearing - 2 high severity/);
  assert.match(out, /Every override is still earning its place\./);
});

test("report marks a load-bearing override dev-only when the runtime tree is clean", () => {
  // A pin protecting build and test tooling is a different finding from one
  // protecting code served to a visitor, so the line has to say which.
  const out = report([
    {
      name: "smol-toml",
      advisories: "2 high severity vulnerabilities",
      runtimeAdvisories: null,
    },
  ]);
  assert.match(
    out,
    /smol-toml: still load-bearing \(dev only\) - 2 high severity vulnerabilities/,
  );
});

test("report marks a load-bearing override runtime when the runtime tree is dirty", () => {
  const out = report([
    {
      name: "react-dom",
      advisories: "3 high severity vulnerabilities",
      runtimeAdvisories: "1 high severity vulnerability",
    },
  ]);
  assert.match(
    out,
    /react-dom: still load-bearing \(runtime\) - 3 high severity vulnerabilities/,
  );
});

test("report leaves the line unqualified when the caller did not split the tree", () => {
  // Claiming "dev only" from a measurement nobody took would be worse than
  // saying nothing, so an absent runtimeAdvisories reads as unmeasured rather
  // than as a clean runtime tree.
  const out = report([
    { name: "a", advisories: "1 low severity vulnerability" },
  ]);
  assert.match(out, /a: still load-bearing - 1 low severity vulnerability/);
  assert.doesNotMatch(out, /dev only|runtime/);
});

test("report ignores the runtime tree for an override that is stale anyway", () => {
  const out = report([
    { name: "a", advisories: null, runtimeAdvisories: null },
  ]);
  assert.match(out, /a: STALE - the tree is clean without it\./);
});

test("report falls back when the audit output states no count", () => {
  // A dirty tree whose output we could not summarise is still load-bearing —
  // the exit status decided that, not the string — so say so rather than
  // printing an empty reason.
  const out = report([{ name: "smol-toml", advisories: "something else" }]);
  assert.match(out, /smol-toml: still load-bearing - advisories remain/);
});

test("report pluralises the removal line for more than one stale override", () => {
  const out = report([
    { name: "a", advisories: null },
    { name: "b", advisories: "1 low severity vulnerability" },
    { name: "c", advisories: null },
  ]);
  assert.match(
    out,
    /Remove these overrides from package\.json and run npm install: a, c\./,
  );
});

test("report says so when there is nothing to remove", () => {
  assert.match(report([]), /Every override is still earning its place\./);
});

test("an audit failure with a report on stdout is a verdict", () => {
  assert.equal(
    isAdvisoryFailure({ status: 1, stdout: Buffer.from("1 high severity\n") }),
    true,
  );
  // A string stdout reads the same way, so the helper does not depend on the
  // caller's stdio encoding.
  assert.equal(
    isAdvisoryFailure({ status: 1, stdout: "1 high severity\n" }),
    true,
  );
});

test("a failure that never audited anything is not a verdict", () => {
  // The regression: under `stdio: "pipe"` an empty stdout is a zero-length
  // Buffer, which is truthy — so a bare `err.stdout` check read a run that
  // failed before auditing as "no advisories", marking a live pin stale.
  assert.equal(
    isAdvisoryFailure({ status: 1, stdout: Buffer.alloc(0) }),
    false,
  );
  assert.equal(isAdvisoryFailure({ status: 1, stdout: "" }), false);
  // A resolution error exits with something other than 1 ...
  assert.equal(
    isAdvisoryFailure({ status: 254, stdout: Buffer.from("ERESOLVE") }),
    false,
  );
  // ... and a process killed by a signal carries no status at all.
  assert.equal(
    isAdvisoryFailure({
      status: null,
      signal: "SIGKILL",
      stdout: Buffer.from("x"),
    }),
    false,
  );
  // npm missing throws a spawn error with neither field.
  assert.equal(isAdvisoryFailure({ code: "ENOENT" }), false);
  assert.equal(isAdvisoryFailure(undefined), false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withoutOverride,
  parseAudit,
  introducedAdvisories,
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

// A trimmed `npm audit --json` report: `vulnerabilities` keyed by package, each
// with a `via` list mixing advisory objects and dependency-chain strings.
function auditJson(vulnerabilities) {
  return JSON.stringify({ auditReportVersion: 2, vulnerabilities });
}

const katex = {
  source: 1240101,
  name: "katex",
  severity: "low",
  url: "https://github.com/advisories/GHSA-238p-pmpm-9mq7",
};
const smolToml = {
  source: 1240090,
  name: "smol-toml",
  severity: "moderate",
  url: "https://github.com/advisories/GHSA-r4xh-jqrq-34v2",
};
const braces = {
  source: 1240110,
  name: "braces",
  severity: "high",
  url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
};

test("parseAudit keys each advisory by the GHSA in its URL", () => {
  const advisories = parseAudit(auditJson({ katex: { via: [katex] } }));
  assert.deepEqual([...advisories.keys()], ["GHSA-238p-pmpm-9mq7"]);
  assert.deepEqual(advisories.get("GHSA-238p-pmpm-9mq7"), {
    id: "GHSA-238p-pmpm-9mq7",
    name: "katex",
    severity: "low",
  });
});

test("parseAudit skips the dependency-chain strings in via", () => {
  // markdownlint is "vulnerable" only because it depends on katex. Counting
  // that string as an advisory of its own would invent one per dependent.
  const advisories = parseAudit(
    auditJson({
      katex: { via: [katex] },
      "micromark-extension-math": { via: ["katex"] },
      markdownlint: { via: ["micromark-extension-math"] },
    }),
  );
  assert.deepEqual([...advisories.keys()], ["GHSA-238p-pmpm-9mq7"]);
});

test("parseAudit falls back to npm's numeric source without a GHSA URL", () => {
  const advisories = parseAudit(
    auditJson({ a: { via: [{ source: 42, name: "a", severity: "low" }] } }),
  );
  assert.deepEqual([...advisories.keys()], ["42"]);
});

test("parseAudit reads a clean report as no advisories", () => {
  assert.equal(parseAudit(auditJson({})).size, 0);
});

test("parseAudit refuses npm's JSON error report", () => {
  // The regression this guards: `npm audit --json` without a lockfile exits 1
  // with this on stdout, which isAdvisoryFailure accepts. Read as a report it
  // has no advisories, and every override would come out stale.
  const enolock = JSON.stringify({
    error: {
      code: "ENOLOCK",
      summary: "This command requires an existing lockfile.",
    },
  });
  assert.throws(() => parseAudit(enolock), /npm audit failed: ENOLOCK/);
});

test("parseAudit still refuses an error report that carries no code or summary", () => {
  // The refusal must not depend on npm filling in the fields it describes the
  // error with, or a terser error report would slip through as a clean tree.
  assert.throws(() => parseAudit(JSON.stringify({ error: {} })), {
    message: "npm audit failed: error",
  });
});

test("parseAudit tolerates a package entry with no via list", () => {
  assert.equal(parseAudit(auditJson({ a: {} })).size, 0);
});

test("parseAudit refuses output that is not an audit report", () => {
  assert.throws(() => parseAudit("{}"), /no vulnerabilities field/);
  assert.throws(() => parseAudit("null"), /no vulnerabilities field/);
  assert.throws(() => parseAudit("2 high severity vulnerabilities"));
});

test("introducedAdvisories ignores advisories the current tree already has", () => {
  // The case the check used to get wrong: braces has no fix, so it is in both
  // trees, and it says nothing about the smol-toml pin.
  const current = parseAudit(auditJson({ braces: { via: [braces] } }));
  const without = parseAudit(auditJson({ braces: { via: [braces] } }));
  assert.deepEqual(introducedAdvisories(current, without), []);
});

test("introducedAdvisories returns what removing the override lets in", () => {
  const current = parseAudit(auditJson({ braces: { via: [braces] } }));
  const without = parseAudit(
    auditJson({
      braces: { via: [braces] },
      "smol-toml": { via: [smolToml] },
      katex: { via: [katex] },
    }),
  );
  assert.deepEqual(
    introducedAdvisories(current, without).map((a) => a.id),
    ["GHSA-238p-pmpm-9mq7", "GHSA-r4xh-jqrq-34v2"],
  );
});

test("introducedAdvisories ignores advisories that removing the override clears", () => {
  // A pin can itself hold a package inside a vulnerable range; dropping it then
  // removes an advisory, which is the stale case, not a reason to keep it.
  const current = parseAudit(auditJson({ "smol-toml": { via: [smolToml] } }));
  const without = parseAudit(auditJson({}));
  assert.deepEqual(introducedAdvisories(current, without), []);
});

const smolIntroduced = [
  { id: "GHSA-r4xh-jqrq-34v2", name: "smol-toml", severity: "moderate" },
];

test("report calls an override stale when removing it lets nothing in", () => {
  const out = report([{ name: "markdown-it", introduced: [] }]);
  assert.match(
    out,
    /markdown-it: STALE - removing it lets in no advisory the tree does not already have\./,
  );
  assert.match(out, /Remove this override from package\.json/);
  assert.match(out, /markdown-it\.$/);
});

test("report names the advisories a load-bearing override keeps out", () => {
  const out = report([{ name: "smol-toml", introduced: smolIntroduced }]);
  assert.match(
    out,
    /smol-toml: still load-bearing - without it: GHSA-r4xh-jqrq-34v2 \(smol-toml, moderate\)/,
  );
  assert.match(out, /Every override is still earning its place\./);
});

test("report marks a load-bearing override dev-only when the runtime tree lets nothing in", () => {
  // A pin protecting build and test tooling is a different finding from one
  // protecting code served to a visitor, so the line has to say which.
  const out = report([
    { name: "smol-toml", introduced: smolIntroduced, runtimeIntroduced: [] },
  ]);
  assert.match(out, /smol-toml: still load-bearing \(dev only\) - without it:/);
});

test("report marks a load-bearing override runtime when the runtime tree lets something in", () => {
  const introduced = [{ id: "GHSA-x", name: "react-dom", severity: "high" }];
  const out = report([
    { name: "react-dom", introduced, runtimeIntroduced: introduced },
  ]);
  assert.match(out, /react-dom: still load-bearing \(runtime\) - without it:/);
});

test("report leaves the line unqualified when the caller did not split the tree", () => {
  // Claiming "dev only" from a measurement nobody took would be worse than
  // saying nothing, so an absent runtimeIntroduced reads as unmeasured rather
  // than as a clean runtime tree.
  const out = report([{ name: "a", introduced: smolIntroduced }]);
  assert.match(out, /a: still load-bearing - without it:/);
  assert.doesNotMatch(out, /dev only|\(runtime\)/);
});

test("report ignores the runtime tree for an override that is stale anyway", () => {
  const out = report([{ name: "a", introduced: [], runtimeIntroduced: [] }]);
  assert.match(out, /a: STALE/);
});

test("report pluralises the removal line for more than one stale override", () => {
  const out = report([
    { name: "a", introduced: [] },
    { name: "b", introduced: smolIntroduced },
    { name: "c", introduced: [] },
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

// The pure half of the stale-override check: what a manifest looks like with one
// `overrides` entry removed, how to read npm's audit of the tree that results,
// and what the difference from the current tree means. The check itself
// (tools/check-stale-overrides.mjs) resolves and audits those trees, which needs
// a subprocess and the registry; everything decidable without either lives
// here, with a test, rather than as untested arithmetic inside the guard.
//
// Dependency-free on purpose: small string and object work over our own
// manifest and npm's own output, not a package-manager library.

// `pkg` with the `overrides` entry `name` removed.
//
// Returns a new object and never mutates the input, so a caller can loop over
// every override without each pass inheriting the last one's removal. The
// `overrides` key is dropped entirely when `name` was its only entry: npm treats
// an empty `overrides` object as declared-but-empty, and leaving one behind
// would resolve a subtly different tree from the one we mean to test — the tree
// as it would be with the override gone.
export function withoutOverride(pkg, name) {
  const overrides = { ...(pkg.overrides ?? {}) };
  delete overrides[name];
  const trimmed = { ...pkg, overrides };
  if (Object.keys(overrides).length === 0) delete trimmed.overrides;
  return trimmed;
}

// Every advisory an `npm audit --json` report names, as a Map from advisory id
// to `{ id, name, severity }`.
//
// The id is the GHSA from the advisory's URL, falling back to npm's numeric
// `source` when there is none, so the same advisory reads as the same key in
// two reports. Only the object entries of each package's `via` are advisories;
// the string entries are the dependency chain ("markdownlint-cli2 is affected
// via markdownlint") and would double-count the advisory they point at.
//
// Throws on anything that is not a report. Under `--json` npm prints its own
// failures to stdout as `{ "error": { … } }` — a missing lockfile exits 1 that
// way, the same status as advisories found — so a caller that trusted the exit
// code alone would read a run that never audited anything as a tree with no
// advisories in it, and call every override stale on the strength of it.
export function parseAudit(json) {
  const report = JSON.parse(json);
  if (report?.error) {
    throw new Error(
      `npm audit failed: ${report.error.code ?? "error"} ${report.error.summary ?? ""}`.trim(),
    );
  }
  const vulnerabilities = report?.vulnerabilities;
  if (typeof vulnerabilities !== "object" || vulnerabilities === null) {
    throw new Error("npm audit output has no vulnerabilities field");
  }
  const advisories = new Map();
  for (const entry of Object.values(vulnerabilities)) {
    for (const via of entry?.via ?? []) {
      if (typeof via !== "object" || via === null) continue;
      const id =
        via.url?.match(/GHSA(?:-[0-9a-z]{4}){3}/i)?.[0] ?? String(via.source);
      advisories.set(id, { id, name: via.name, severity: via.severity });
    }
  }
  return advisories;
}

// The advisories in `without` that `current` does not have, sorted by id.
//
// This is the whole question an override answers to: does removing it let in an
// advisory the tree is free of today? Comparing against the current tree rather
// than against a clean one is the point. An advisory nobody can fix yet (no
// patched release exists) sits in both trees, so it says nothing about the pin;
// requiring a clean audit instead would keep every override "load-bearing" for
// as long as any unrelated advisory stayed open anywhere in the tree.
//
// Keyed by advisory, not by installed copy: a pin that fixes one copy of a
// package while another copy elsewhere in the tree stays on the same advisory
// reads as stale here. npm applies an override to every copy it matches, so
// that only happens when the pin's selector is narrower than the package.
export function introducedAdvisories(current, without) {
  return [...without.values()]
    .filter((advisory) => !current.has(advisory.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// One override's verdict line.
//
// `introduced` is what removing this override lets in (introducedAdvisories
// against the current tree). Empty means nothing the pin is doing is still
// needed, so it is now only holding a package back — which is the whole
// finding.
//
// `runtimeIntroduced` is the same for the runtime-only tree (`npm audit
// --omit=dev`), and is what keeps this usable in a repo that ships runtime
// dependencies. An override held alive by a runtime advisory is protecting code
// served to every visitor; one held alive by a dev-only advisory is protecting
// build and test tooling that never reaches a browser. A flat "still
// load-bearing" conflates the two, which is only harmless where the whole tree
// is dev — so say which, whenever the caller measured it. Omit the field (or
// pass undefined) to say it did not split the tree, and the line stays
// unqualified rather than claiming a distinction nobody checked.
function verdict({ name, introduced, runtimeIntroduced }) {
  if (introduced.length === 0)
    return `  ${name}: STALE - removing it lets in no advisory the tree does not already have.`;
  const scope =
    runtimeIntroduced === undefined
      ? ""
      : runtimeIntroduced.length === 0
        ? " (dev only)"
        : " (runtime)";
  const reasons = introduced
    .map(({ id, name: pkg, severity }) => `${id} (${pkg}, ${severity})`)
    .join(", ");
  return `  ${name}: still load-bearing${scope} - without it: ${reasons}`;
}

// The report for a finished run: one line per override, then the verdict.
//
// `results` is an array of the objects `verdict` reads above.
export function report(results) {
  const lines = results.map(verdict);
  const stale = results
    .filter((r) => r.introduced.length === 0)
    .map((r) => r.name);
  lines.push(
    "",
    stale.length === 0
      ? "Every override is still earning its place."
      : `Remove ${stale.length === 1 ? "this override" : "these overrides"} from ` +
          `package.json and run npm install: ${stale.join(", ")}.`,
  );
  return lines.join("\n");
}

// Whether a thrown `npm audit` failure is a verdict on the tree or a broken run.
//
// `npm audit` exits non-zero both when it found advisories and when it could not
// look — a resolution error, a registry outage, npm missing — and the caller
// runs it through execFileSync, so both arrive as a thrown error. Only the first
// is an answer. Reading any failure as advisories would report a pin as still
// load-bearing on the strength of a run that never audited anything, which is
// the one way this check can lie in the direction of doing nothing.
//
// Both halves of the test earn their place. `status === 1` is the exit code npm
// reserves for advisories found; a failure before the audit runs reports a
// different one, or none at all when the process was killed by a signal. The
// length test covers the rest: such a failure leaves stdout empty, and under
// `stdio: "pipe"` an empty stdout is a zero-length Buffer — truthy, so a bare
// `err.stdout` check would pass it through as a report of no advisories at all.
// What this cannot see is a `--json` error, which exits 1 with its report on
// stdout; parseAudit is what refuses that one.
export function isAdvisoryFailure(err) {
  return err?.status === 1 && err?.stdout?.length > 0;
}

// The pure half of the stale-override check: what a manifest looks like with one
// `overrides` entry removed, and how to read npm's verdict on the tree that
// results. The check itself (tools/check-stale-overrides.mjs) resolves and
// audits that manifest, which needs a subprocess and the registry; everything
// decidable without either lives here, with a test, rather than as untested
// arithmetic inside the guard.
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

// The one line of `npm audit` output that states the count, e.g.
// "2 high severity vulnerabilities", or undefined when no line does.
//
// Matching on the "vulnerabilit" stem covers both the singular and the plural
// npm prints, and the line is returned trimmed so it can be dropped straight
// into a report. This reads a human summary on purpose: the check only needs
// something to show next to a still-load-bearing override, and the exit status
// — not this string — is what decides stale from load-bearing.
export function advisorySummary(auditOutput) {
  return auditOutput
    .split("\n")
    .find((line) => /vulnerabilit/i.test(line))
    ?.trim();
}

// One override's verdict line.
//
// `advisories` is the audit output for the whole tree without this override, or
// null when that tree was clean. Clean means the advisory the pin was added for
// no longer applies, so the pin is now only holding a package back — which is
// the whole finding.
//
// `runtimeAdvisories` is the same for the runtime-only tree (`npm audit
// --omit=dev`), and is what keeps this usable in a repo that ships runtime
// dependencies. An override held alive by a runtime advisory is protecting code
// served to every visitor; one held alive by a dev-only advisory is protecting
// build and test tooling that never reaches a browser. A flat "still
// load-bearing" conflates the two, which is only harmless where the whole tree
// is dev — so say which, whenever the caller measured it. Omit the field (or
// pass undefined) to say it did not split the tree, and the line stays
// unqualified rather than claiming a distinction nobody checked.
function verdict({ name, advisories, runtimeAdvisories }) {
  if (advisories === null)
    return `  ${name}: STALE - the tree is clean without it.`;
  const reason = advisorySummary(advisories) ?? "advisories remain";
  const scope =
    runtimeAdvisories === undefined
      ? ""
      : runtimeAdvisories === null
        ? " (dev only)"
        : " (runtime)";
  return `  ${name}: still load-bearing${scope} - ${reason}`;
}

// The report for a finished run: one line per override, then the verdict.
//
// `results` is an array of the objects `verdict` reads above.
export function report(results) {
  const lines = results.map(verdict);
  const stale = results.filter((r) => r.advisories === null).map((r) => r.name);
  lines.push(
    "",
    stale.length === 0
      ? "Every override is still earning its place."
      : `Remove ${stale.length === 1 ? "this override" : "these overrides"} from ` +
          `package.json and run npm install: ${stale.join(", ")}.`,
  );
  return lines.join("\n");
}

// Parse and compare Content-Security-Policy directives. Kept out of check-csp.mjs
// so the parsing (first-wins over a repeated directive) and the two-policy
// lock-step comparison are a testable unit instead of top-level code in the
// guard.
//
// Dependency-free on purpose: small string work over our own two policies, not a
// general CSP parser.

// A CSP as a map of directive name -> set of values, so two policies can be
// compared directive by directive, order- and whitespace-insensitively.
//
// When a directive name is repeated WITHIN a single policy, the browser honours
// the FIRST occurrence and ignores the rest (CSP "parse a serialized policy": a
// duplicate directive name is discarded). So keep the first, not the last: a
// drifted `script-src *; …; script-src 'self' 'sha256-…'` is enforced as the
// permissive `*`, and reading the last (restrictive) copy would let a guard
// green-light a policy the browser actually serves wide open.
export function parseCsp(csp) {
  const directives = new Map();
  for (const part of csp.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/).filter(Boolean);
    const key = name?.toLowerCase();
    if (key && !directives.has(key)) directives.set(key, new Set(values));
  }
  return directives;
}

// Directives the .htaccess header carries that a <meta> CSP cannot usefully
// express (a browser ignores frame-ancestors in a meta policy): the header is
// allowed to add exactly these on top of the <meta> baseline, so they are
// excluded from the lock-step comparison on BOTH sides. Because there is no
// <meta> counterpart to lock-step against, each maps to its EXPECTED value set
// instead, which comparePolicies asserts the header still carries — otherwise
// the header could weaken `frame-ancestors 'none'` to `frame-ancestors *` (or
// an attacker origin) and, with only a presence check, ship green. A valueless
// directive (upgrade-insecure-requests) pins to the empty set.
export const HEADER_ONLY = new Map([
  ["frame-ancestors", ["'none'"]],
  ["upgrade-insecure-requests", []],
]);

// Human-readable list of directives that differ between two CSP maps (a
// directive present in only one, or present in both with differing values).
export function directiveDiff(meta, header) {
  const diffs = [];
  for (const name of new Set([...meta.keys(), ...header.keys()])) {
    const m = meta.get(name);
    const h = header.get(name);
    if (!m) diffs.push(`${name}: only in .htaccess`);
    else if (!h) diffs.push(`${name}: only in <meta>`);
    else if (m.size !== h.size || ![...m].every((v) => h.has(v)))
      diffs.push(
        `${name}: <meta> [${[...m].join(" ")}] vs .htaccess [${[...h].join(" ")}]`,
      );
  }
  return diffs;
}

// Compare the <meta> and .htaccess policies for lock-step. Takes each already
// parsed to a directive map (via parseCsp) so the caller parses each policy once
// and reuses the maps — for the script-src lookup too — rather than re-parsing.
// Returns { missingHeaderOnly, headerOnlyMismatches, diffs }:
//   - missingHeaderOnly: header-only directives absent from the header. They are
//     stripped from the comparison, so their absence would otherwise go unnoticed
//     — asserting their presence keeps deleting frame-ancestors or
//     upgrade-insecure-requests from .htaccess from silently dropping the
//     clickjacking and HTTPS-upgrade protections.
//   - headerOnlyMismatches: header-only directives whose header value drifted
//     from the pinned expected value in HEADER_ONLY — so weakening
//     `frame-ancestors 'none'` to a permissive value is caught, not just its
//     deletion. Presence alone was a fail-open: a weakened but present directive
//     slipped through.
//   - diffs: every other directive must match exactly, so loosening or dropping
//     one in only one file is caught, not just a drifted script hash.
//
// Header-only directives are stripped from BOTH policies, not just the header:
// adding one to the <meta> too (harmless — the browser ignores frame-ancestors
// there) must not read as a `only in <meta>` mismatch and fail the build.
export function comparePolicies(metaDirectives, headerDirectives) {
  const missingHeaderOnly = [];
  const headerOnlyMismatches = [];
  for (const [name, expected] of HEADER_ONLY) {
    if (!headerDirectives.has(name)) {
      missingHeaderOnly.push(name);
      continue;
    }
    const actual = headerDirectives.get(name);
    const expectedSet = new Set(expected);
    if (
      actual.size !== expectedSet.size ||
      ![...expectedSet].every((v) => actual.has(v))
    ) {
      headerOnlyMismatches.push(
        `${name}: expected [${[...expectedSet].join(" ")}] but .htaccess has [${[...actual].join(" ")}]`,
      );
    }
  }
  const withoutHeaderOnly = (directives) =>
    new Map([...directives].filter(([name]) => !HEADER_ONLY.has(name)));
  const diffs = directiveDiff(
    withoutHeaderOnly(metaDirectives),
    withoutHeaderOnly(headerDirectives),
  );
  return { missingHeaderOnly, headerOnlyMismatches, diffs };
}

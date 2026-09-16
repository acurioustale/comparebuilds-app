// Read the live Content-Security-Policy the .htaccess header sets. Kept out of
// check-csp.mjs so the scanning rules — Apache line-continuation, comment
// skipping, request-scope tracking and the last-wins over repeated headers —
// are one testable unit instead of inline top-level code in the guard.
//
// Dependency-free on purpose: a small scan over our own well-formatted config,
// not a general Apache parser.

// A request-scoping container: a CSP inside one applies only to matching
// requests, so it must not be read as the global header. <IfModule>/<IfDefine>/
// <IfVersion> are load-time conditionals rather than request scopes (the live
// CSP itself sits inside <IfModule mod_headers.c>), so they stay transparent.
// <Limit>/<LimitExcept> scope by HTTP method (both valid under AllowOverride
// Limit): a CSP inside <Limit GET> would be served only for GET, so it too must
// not be read as the global policy — omitting them let a method-scoped (and so
// partly-absent) CSP validate as if it were unconditional.
const SCOPING_SECTION =
  /^(?:Files|FilesMatch|Directory|DirectoryMatch|Location|LocationMatch|If|ElseIf|Else|Proxy|ProxyMatch|Limit|LimitExcept)$/i;

// A CSP-bearing Header line, and the one form this guard understands: a plain,
// unconditional `Header [always] set Content-Security-Policy "…"` with nothing
// trailing the quoted value. Anything else that touches the header serves the
// browser something other than that single value — `append`/`edit`/`add`
// combine with or rewrite the policy, and a trailing `env=`/`expr=` condition
// makes the `set` apply only sometimes — so validating the lone value would
// green-light a policy the server may actually serve weakened or not at all. The
// guard flags such a line so the caller fails closed rather than trusting it.
//
// The name match must not extend into a longer header: `\b` also ends before the
// hyphen of `Content-Security-Policy-Report-Only`, so an added report-only header
// — a separate, additive header that weakens nothing — would be flagged as an
// unreadable CSP form and fail the gate.
const CSP_HEADER_LINE = /^Header\b.*\bContent-Security-Policy(?!-)\b/i;
const SUPPORTED_CSP_SET =
  /^Header\s+(?:always\s+)?set\s+Content-Security-Policy\s+"[^"]*"\s*$/i;

// The `Header [always] set Content-Security-Policy "…"` value from `htaccess`,
// plus whether its scoping containers balance and whether any unsupported
// CSP-touching Header form is present. Returns
// { headerCsp: string | undefined, scopesUnbalanced: boolean,
//   unsupportedHeaders: string[] }.
//
// Takes the LAST live match, not the first: `Header set` replaces any earlier
// header of the same name, so when two are present Apache serves the last —
// breaking on the first would validate a strict policy while the browser is
// served a looser one added below it. Only a TOP-LEVEL directive is the global
// policy; anything inside a request-scoping container is ignored, and an
// unbalanced container (a stray close, or an unclosed open) is reported so the
// caller can fail closed rather than trust a possibly-mis-scoped read.
export function readHeaderCsp(htaccess) {
  // Apache joins a directive split with a trailing backslash onto the next line
  // (the backslash must immediately precede the newline). Reassemble those first
  // so a wrapped `Header set …` is scanned as the one logical line Apache serves
  // — otherwise the split value never closes its quote and this would report no
  // policy on markup the server delivers fine.
  const lines = htaccess.replace(/\\\r?\n/g, "").split("\n");
  let headerCsp;
  let scopeDepth = 0;
  let scopesUnbalanced = false;
  const unsupportedHeaders = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("#")) continue;
    const section = line.match(/^<(\/?)([A-Za-z]+)/);
    if (section && SCOPING_SECTION.test(section[2])) {
      if (section[1] === "/") {
        // A close with no matching open: the structure is broken. Flag it and
        // clamp back to zero so the rest of the scan stays anchored.
        if (--scopeDepth < 0) {
          scopesUnbalanced = true;
          scopeDepth = 0;
        }
      } else scopeDepth += 1;
      continue;
    }
    if (scopeDepth > 0) continue;
    // A CSP-touching Header line that is not the plain `set "…"` form serves a
    // policy this guard can't read from a single value — flag it to fail closed.
    if (CSP_HEADER_LINE.test(line) && !SUPPORTED_CSP_SET.test(line)) {
      unsupportedHeaders.push(line);
      continue;
    }
    const match = line.match(
      /^Header\s+(?:always\s+)?set\s+Content-Security-Policy\s+"([^"]*)"/i,
    );
    if (match) {
      headerCsp = match[1];
    }
  }
  // An unclosed container leaves the depth above zero, having swallowed every
  // directive below it as nested — the global CSP among them included.
  if (scopeDepth !== 0) scopesUnbalanced = true;
  return { headerCsp, scopesUnbalanced, unsupportedHeaders };
}

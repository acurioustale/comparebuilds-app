// Shared PHP `require`/`include` scanner. The deploy-set guard needs to know
// which files a shipped PHP file pulls in at runtime, because a required file
// left out of the staged set is the one deploy failure the gate cannot otherwise
// see: rsync --delete removes it server-side and every request that reaches the
// require fatals.
//
// Only the one form this codebase uses is understood — a `__DIR__`-relative
// literal path, e.g. `require_once __DIR__ . '/lib/RateLimiter.php';`. That is
// deliberate: a dynamic require (a variable, a concatenated name) cannot be
// resolved statically, so instead of guessing, it is reported separately and the
// caller fails closed rather than assuring a dependency it never checked.
//
// Dependency-free on purpose: a small scan over our own PHP, not a parser.

// `require`/`require_once`/`include`/`include_once`, optionally parenthesised,
// then `__DIR__` joined by `.` to a single-quoted or double-quoted literal. The
// literal may not itself interpolate (a `$` in a double-quoted PHP string is a
// variable), so such a path falls through to the dynamic branch below.
const DIR_RELATIVE =
  /\b(?:require|include)(?:_once)?\s*\(?\s*__DIR__\s*\.\s*(?:'([^']*)'|"([^"$\\]*)")\s*\)?\s*;/g;

// Any require/include at all, so a form the pattern above does not cover can be
// counted rather than silently skipped. `\b` on both sides keeps it off the
// variable `$required` and the like.
const ANY_REQUIRE = /\b(?:require|include)(?:_once)?\b/g;

// Strip comments before scanning, so a commented-out require neither demands a
// file nor inflates the unresolved tally. Quoted strings are matched by the same
// pass and kept verbatim: without that, a `//` inside a string (a URL in a
// comment-free line) would swallow the rest of the line and could hide a real
// require declared after it.
const COMMENTS_AND_STRINGS =
  /('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*/g;

const stripComments = (php) =>
  php.replace(COMMENTS_AND_STRINGS, (match, string) => string ?? "");

/**
 * Every `__DIR__`-relative require target in `php`, as the literal suffix joined
 * to `__DIR__` (e.g. "/lib/RateLimiter.php"), plus a count of the require
 * statements this scanner could not resolve to a literal path.
 *
 * @param {string} php PHP source text
 * @returns {{ targets: string[], unresolved: number }}
 */
export function phpRequires(php) {
  const code = stripComments(php);
  const targets = [];
  for (const [, single, double] of code.matchAll(DIR_RELATIVE)) {
    targets.push(single ?? double);
  }
  const total = (code.match(ANY_REQUIRE) ?? []).length;
  // Every require the literal pattern matched is resolved; the rest are not.
  // Clamp at zero: ANY_REQUIRE is the looser pattern, so it can only over-count
  // relative to the resolved set in pathological input, never under-count.
  return { targets, unresolved: Math.max(0, total - targets.length) };
}

/**
 * Resolve a `__DIR__`-relative require target against the directory of the file
 * that declares it, to a repo-relative POSIX path. A target that climbs above
 * `root` resolves to a path starting with "../" — this codebase requires
 * `config.php` from one level above the web root that way, and such a path is
 * deliberately outside the deployed tree.
 *
 * @param {string} fileDir Repo-relative directory of the requiring file (e.g. "api/cron")
 * @param {string} target The literal joined to __DIR__ (e.g. "/../share.php")
 * @returns {string} Repo-relative path, "../"-prefixed when it escapes the repo
 */
export function resolveRequire(fileDir, target) {
  const parts = `${fileDir}/${target}`.split("/");
  const out = [];
  let up = 0;
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length) out.pop();
      else up += 1;
      continue;
    }
    out.push(part);
  }
  return "../".repeat(up) + out.join("/");
}

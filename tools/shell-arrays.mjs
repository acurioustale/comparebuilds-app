// Read a one-line bash array literal out of a shell script.
//
// The deploy-set guard's whole value is that it reads the deploy's OWN list
// rather than keeping a second copy of it, so this parser is the seam where the
// guard could quietly under-verify: a regex that matches only part of the array,
// or misses a second assignment, fails in the fail-open direction — the guard
// still prints a reassuring summary while checking less than it claims. That is
// the repo's stated reason for putting a guard's parsing in a tested helper
// instead of a private regex, so it lives here.
//
// Deliberately narrow: exactly one `NAME=(a b c)` on a single line, which is the
// shape deploy.sh is required to keep (and says so next to each array). Anything
// else — a second assignment, a `+=` append, a multi-line literal — is reported
// as an error rather than parsed on a guess, so extending deploy.sh forces a
// maintainer through here rather than past the check.

/**
 * Entries of the single one-line `name=( ... )` array literal in `source`.
 *
 * @param {string} source shell script text
 * @param {string} name array variable name, e.g. "API_ASSETS"
 * @returns {{ok: true, entries: string[]}
 *   | {ok: false, reason: "missing" | "multiple" | "multiline"}}
 *   `multiple` covers both a second assignment and a `+=` append: either means
 *   the single match below would read only part of the set. `multiline` is an
 *   assignment whose literal does not close on its own line.
 */
export function readShellArray(source, name) {
  // Anchored to the start of a line so a `# NAME=(…)` example in the prose above
  // the real array is not grabbed as the list, and so a longer variable whose
  // name merely ends in `name` cannot match.
  const assignments =
    source.match(new RegExp(String.raw`^[ \t]*${name}[ \t]*\+?=\(`, "gm")) ??
    [];
  if (assignments.length > 1 || assignments.some((m) => m.includes("+="))) {
    return { ok: false, reason: "multiple" };
  }

  // `[^)\n]*` confines the match to ONE line on purpose. Allowing it to span
  // lines would read up to the first `)` anywhere below — which for a literal
  // holding a parenthesis (in an entry, or in a trailing comment) is a partial
  // list that looks like a whole one, the exact fail-open this helper exists to
  // prevent. A literal that does not close on its own line is reported instead.
  const literal = source.match(
    new RegExp(String.raw`^[ \t]*${name}=\(([^)\n]*)\)`, "m"),
  );
  if (!literal) {
    return { ok: false, reason: assignments.length ? "multiline" : "missing" };
  }

  return {
    ok: true,
    entries: literal[1].replace(/#.*$/gm, "").split(/\s+/).filter(Boolean),
  };
}

// Characters git reads as pathspec magic or glob. Entries of these arrays are
// passed to `git archive` as pathspecs, where such a character would resolve
// against HEAD by rules no plain-path check here reproduces — so the guard
// requires literal paths and this is the set it rejects.
const PATHSPEC_MAGIC = /[*?[\]\\]|^[:!]/;

/**
 * True when `entry` is a plain literal path, safe to treat as both a filesystem
 * path (how the guard resolves it) and a git pathspec (how the deploy uses it).
 *
 * @param {string} entry
 * @returns {boolean}
 */
export const isLiteralPath = (entry) =>
  !PATHSPEC_MAGIC.test(entry) && !entry.split("/").includes("..");

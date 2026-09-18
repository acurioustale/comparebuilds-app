// Shared reader for a site's security.txt (RFC 9116): the published contact
// route a researcher is meant to find, and the date it stops being valid.
//
// Two kinds of check read that file and have to agree on what it says. A parity
// suite binds the contacts and Canonical it declares to the prose policy and the
// canonical origin the markup declares, and fails on an edit. An expiry guard
// reads the same fields to watch the clock on `Expires`, and fails on a date.
// Neither owns the reading: a field regex that is subtly wrong on real input
// fails in the fail-open direction — the check passes while the published file
// is invalid — so the parsing lives here once, with a test, rather than being
// written twice and got wrong in one of them.
//
// Dependency-free on purpose: RFC 9116 is a flat `Name: value` field format over
// UTF-8, not something needing a parser library.

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The fields of an RFC 9116 file, as Map(name → values in file order).
 *
 * Comment lines (`#`) and blank lines are ignored, per the grammar. A field name
 * MAY repeat — two Contact lines is the normal case, and the RFC says a reporter
 * should read them as an ordered preference list — so every value is collected
 * rather than the last one winning. Names are kept verbatim: the RFC defines
 * them case-insensitively, but every file we write uses the canonical casing,
 * and a caller asking for "Contact" should not silently match "CONTACT" written
 * by mistake.
 *
 * @param {string} text File contents
 * @returns {Map<string, string[]>}
 * @throws {Error} on a line that is neither blank, a comment, nor `Name: value`
 */
export function parseSecurityTxt(text) {
  const found = new Map();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z-]+):\s*(.+)$/);
    // Throwing rather than skipping is deliberate. A line this does not
    // recognise is a line a consumer's parser may also reject, which can
    // invalidate the whole file — so it must be loud, not quietly dropped.
    if (!match) {
      throw new Error(
        `security.txt line is not a "Name: value" field: ${line}`,
      );
    }
    found.set(match[1], [...(found.get(match[1]) ?? []), match[2]]);
  }
  return found;
}

/**
 * What the file's `Expires` field says about its remaining life.
 *
 * RFC 9116 requires exactly one Expires, and a file past it is invalid — a
 * conforming consumer is told to ignore it — so a lapse silently un-publishes
 * the contact. `warnWithinDays` exists to make that arrive as notice rather than
 * as a cliff: the date is a human commitment nothing can derive, so the only
 * useful automation is telling the owner it is coming.
 *
 * @param {Map<string, string[]>} fields Parsed fields
 * @param {{ now?: Date, warnWithinDays?: number }} [options]
 * @returns {{ state: "missing"|"repeated"|"unparseable"|"lapsed"|"warn"|"ok",
 *             expires: string | undefined, daysLeft: number | undefined }}
 */
export function expiryStatus(fields, options = {}) {
  const { now = new Date(), warnWithinDays = 60 } = options;
  const values = fields.get("Expires");
  if (values === undefined) {
    return { state: "missing", expires: undefined, daysLeft: undefined };
  }
  // "The Expires field MUST NOT appear more than once" — with two, which one
  // binds is undefined, so it is a defect in its own right rather than a case to
  // resolve by picking one.
  if (values.length > 1) {
    return { state: "repeated", expires: undefined, daysLeft: undefined };
  }
  const [expires] = values;
  const when = new Date(expires);
  if (Number.isNaN(when.getTime())) {
    return { state: "unparseable", expires, daysLeft: undefined };
  }
  const daysLeft = Math.floor((when.getTime() - now.getTime()) / DAY_MS);
  if (when.getTime() <= now.getTime()) {
    return { state: "lapsed", expires, daysLeft };
  }
  return {
    state: daysLeft <= warnWithinDays ? "warn" : "ok",
    expires,
    daysLeft,
  };
}

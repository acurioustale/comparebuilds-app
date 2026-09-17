import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSecurityTxt, expiryStatus } from "./security-txt.mjs";

// The helper behind the expiry guard and the parity suite. Both read the same
// file, so the reading itself is what has to be right: a field parser that
// quietly drops a line, or an expiry comparison off by a boundary, fails in the
// fail-open direction — the check passes while the published contact is
// invalid. These are the cases a real file can present.
//
// Every assertion here pins a fixed `now` against a fixed date. Nothing in this
// file reads the clock, because that is the whole point of the split: the gate
// tests the arithmetic, the non-gating guard applies it to today.

test("parseSecurityTxt collects every value of a repeated field, in file order", () => {
  // Two Contact lines is the normal shape (mailto plus the advisory form) and
  // the RFC reads them as an ordered preference list, so last-wins would throw
  // away the preferred route.
  const fields = parseSecurityTxt(
    [
      "Contact: mailto:me@example.com",
      "Contact: https://example.com/report",
      "Expires: 2027-09-01T00:00:00.000Z",
    ].join("\n"),
  );
  assert.deepEqual(fields.get("Contact"), [
    "mailto:me@example.com",
    "https://example.com/report",
  ]);
  assert.deepEqual(fields.get("Expires"), ["2027-09-01T00:00:00.000Z"]);
});

test("parseSecurityTxt ignores comments and blank lines", () => {
  const fields = parseSecurityTxt(
    ["# a header comment", "", "Contact: mailto:me@example.com", "  ", ""].join(
      "\n",
    ),
  );
  assert.deepEqual([...fields.keys()], ["Contact"]);
});

test("parseSecurityTxt keeps a value containing a colon intact", () => {
  // Splitting on every colon would truncate every URL in the file to its
  // scheme — the failure that makes a hand-rolled parser dangerous here.
  const fields = parseSecurityTxt(
    "Policy: https://github.com/o/r/blob/main/SECURITY.md",
  );
  assert.deepEqual(fields.get("Policy"), [
    "https://github.com/o/r/blob/main/SECURITY.md",
  ]);
});

test("parseSecurityTxt throws on a line that is not a field", () => {
  // Loud, not skipped: a consumer's parser may reject the same line and with it
  // the whole file.
  assert.throws(
    () =>
      parseSecurityTxt("Contact: mailto:me@example.com\nnot a field at all"),
    /not a "Name: value" field/,
  );
});

const now = new Date("2026-09-17T12:00:00.000Z");
const at = (expires) =>
  expiryStatus(new Map([["Expires", [expires]]]), { now, warnWithinDays: 60 });

test("expiryStatus reports a comfortably future date as ok", () => {
  const status = at("2027-09-01T00:00:00.000Z");
  assert.equal(status.state, "ok");
  assert.equal(status.daysLeft, 348);
});

test("expiryStatus warns once the date is inside the notice window", () => {
  const status = at("2026-10-01T12:00:00.000Z");
  assert.equal(status.state, "warn");
  assert.equal(status.daysLeft, 14);
});

test("expiryStatus treats the window edge as ok, one day in as a warning", () => {
  // The boundary decides whether the owner gets the full notice period, so pin
  // both sides of it rather than trusting the comparison's direction.
  assert.equal(at("2026-11-17T12:00:00.000Z").daysLeft, 61);
  assert.equal(at("2026-11-17T12:00:00.000Z").state, "ok");
  assert.equal(at("2026-11-16T12:00:00.000Z").daysLeft, 60);
  assert.equal(at("2026-11-16T12:00:00.000Z").state, "warn");
});

test("expiryStatus reports a past date as lapsed, with how long ago", () => {
  const status = at("2026-09-01T12:00:00.000Z");
  assert.equal(status.state, "lapsed");
  assert.equal(status.daysLeft, -16);
});

test("expiryStatus treats the instant of expiry as already lapsed", () => {
  // RFC 9116 says a consumer should ignore the file once the moment arrives, so
  // `now === Expires` is invalid, not the last valid second.
  assert.equal(at("2026-09-17T12:00:00.000Z").state, "lapsed");
});

test("expiryStatus distinguishes a missing, repeated and unreadable Expires", () => {
  // Three different defects with three different fixes, so the guard must be
  // able to say which one it found instead of a flat "bad Expires".
  assert.equal(expiryStatus(new Map(), { now }).state, "missing");
  assert.equal(
    expiryStatus(new Map([["Expires", ["2027-01-01", "2028-01-01"]]]), { now })
      .state,
    "repeated",
  );
  assert.equal(at("next tuesday").state, "unparseable");
});

test("expiryStatus defaults its options rather than requiring them", () => {
  // The guard calls it with only `warnWithinDays`, so the `now` default is real
  // API surface. Asserted on the one verdict that is reached before the clock is
  // consulted, so pinning it here still reads no date.
  assert.equal(expiryStatus(new Map()).state, "missing");
});

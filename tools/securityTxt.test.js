import { describe, test, expect } from "vitest";
import { parseSecurityTxt, expiryStatus } from "./security-txt.mjs";

// The helper behind the expiry guard and the SECURITY.md parity suite. Both read
// the same file, so the reading itself is what has to be right: a field parser
// that quietly drops a line, or an expiry comparison off by a boundary, fails in
// the fail-open direction — the guard passes while the published contact is
// invalid. These are the cases a real file can present.

describe("parseSecurityTxt", () => {
  test("collects every value of a repeated field, in file order", () => {
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
    expect(fields.get("Contact")).toEqual([
      "mailto:me@example.com",
      "https://example.com/report",
    ]);
    expect(fields.get("Expires")).toEqual(["2027-09-01T00:00:00.000Z"]);
  });

  test("ignores comments and blank lines", () => {
    const fields = parseSecurityTxt(
      [
        "# a header comment",
        "",
        "Contact: mailto:me@example.com",
        "  ",
        "",
      ].join("\n"),
    );
    expect([...fields.keys()]).toEqual(["Contact"]);
  });

  test("keeps a value containing a colon intact", () => {
    // Splitting on every colon would truncate every URL in the file to its
    // scheme — the failure that makes a hand-rolled parser dangerous here.
    const fields = parseSecurityTxt(
      "Policy: https://github.com/o/r/blob/main/SECURITY.md",
    );
    expect(fields.get("Policy")).toEqual([
      "https://github.com/o/r/blob/main/SECURITY.md",
    ]);
  });

  test("throws on a line that is not a field", () => {
    // Loud, not skipped: a consumer's parser may reject the same line and with
    // it the whole file.
    expect(() =>
      parseSecurityTxt("Contact: mailto:me@example.com\nnot a field at all"),
    ).toThrow(/not a "Name: value" field/);
  });
});

describe("expiryStatus", () => {
  const now = new Date("2026-09-17T12:00:00.000Z");
  const at = (expires) =>
    expiryStatus(new Map([["Expires", [expires]]]), {
      now,
      warnWithinDays: 60,
    });

  test("reports a comfortably future date as ok", () => {
    const status = at("2027-09-01T00:00:00.000Z");
    expect(status.state).toBe("ok");
    expect(status.daysLeft).toBe(348);
  });

  test("warns once the date is inside the notice window", () => {
    const status = at("2026-10-01T12:00:00.000Z");
    expect(status.state).toBe("warn");
    expect(status.daysLeft).toBe(14);
  });

  test("treats the window edge as still ok, one day in as a warning", () => {
    // The boundary decides whether the owner gets the full notice period, so pin
    // both sides of it rather than trusting the comparison's direction.
    expect(at("2026-11-17T12:00:00.000Z").daysLeft).toBe(61);
    expect(at("2026-11-17T12:00:00.000Z").state).toBe("ok");
    expect(at("2026-11-16T12:00:00.000Z").daysLeft).toBe(60);
    expect(at("2026-11-16T12:00:00.000Z").state).toBe("warn");
  });

  test("reports a past date as lapsed, with how long ago", () => {
    const status = at("2026-09-01T12:00:00.000Z");
    expect(status.state).toBe("lapsed");
    expect(status.daysLeft).toBe(-16);
  });

  test("treats the instant of expiry as already lapsed", () => {
    // RFC 9116 says a consumer should ignore the file once the moment arrives,
    // so `now === Expires` is invalid, not the last valid second.
    expect(at("2026-09-17T12:00:00.000Z").state).toBe("lapsed");
  });

  test("distinguishes a missing, repeated and unreadable Expires", () => {
    // Three different defects with three different fixes, so the guard must be
    // able to say which one it found instead of a flat "bad Expires".
    expect(expiryStatus(new Map(), { now }).state).toBe("missing");
    expect(
      expiryStatus(new Map([["Expires", ["2027-01-01", "2028-01-01"]]]), {
        now,
      }).state,
    ).toBe("repeated");
    expect(at("next tuesday").state).toBe("unparseable");
  });
});

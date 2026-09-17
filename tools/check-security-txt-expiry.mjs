// Watch the clock on public/.well-known/security.txt's `Expires` field.
//
// This guard is deliberately NOT in the gate. Everything validate.sh runs fails
// only because someone changed a file; this one fails because a date passed, and
// a check that can redden a green tree on the calendar's schedule would block an
// unrelated deploy on a day nobody touched the security contact. Same reasoning
// that keeps `npm audit` out of the gate. Its home is the weekly links workflow,
// which is non-gating and already fetches this file.
//
// The parity assertions that DO belong in the gate — the contact address
// matching SECURITY.md, the Canonical matching index.html, the required fields
// being present — live in src/lib/securityTxtParity.test.js, because only an
// edit can break those.
//
// Exit codes: 0 while the file is valid (a warning inside the window still exits
// 0 — notice, not failure), 1 once it has lapsed or Expires cannot be read.
import { readFile } from "node:fs/promises";
import { parseSecurityTxt, expiryStatus } from "./security-txt.mjs";

const FILE = "public/.well-known/security.txt";
const WARN_WITHIN_DAYS = 60;

const path = new URL(`../${FILE}`, import.meta.url);

let text;
try {
  text = await readFile(path, "utf8");
} catch {
  console.error(`check-security-txt-expiry: ${FILE} not found`);
  process.exit(1);
}

let fields;
try {
  fields = parseSecurityTxt(text);
} catch (err) {
  console.error(`check-security-txt-expiry: ${err.message}`);
  process.exit(1);
}

const { state, expires, daysLeft } = expiryStatus(fields, {
  warnWithinDays: WARN_WITHIN_DAYS,
});

// How to fix it, printed with every outcome that needs a human: the date is an
// assertion about how long the contact stands, so nothing here can derive the
// replacement — a reader must choose one.
const remedy =
  `  Set a new Expires in ${FILE} (no more than a year out, per RFC 9116),\n` +
  "  after confirming the contacts it publishes are still the right ones.";

switch (state) {
  case "missing":
    console.error(
      `check-security-txt-expiry: ${FILE} declares no Expires, which RFC 9116\n` +
        "  requires — without it a consumer cannot tell whether the file is current.\n" +
        remedy,
    );
    process.exit(1);
    break;
  case "repeated":
    console.error(
      `check-security-txt-expiry: ${FILE} declares Expires more than once; the\n` +
        "  RFC allows exactly one, and which of them binds is undefined.\n" +
        remedy,
    );
    process.exit(1);
    break;
  case "unparseable":
    console.error(
      `check-security-txt-expiry: Expires is not a valid timestamp: ${expires}\n` +
        "  RFC 9116 wants an ISO 8601 instant, e.g. 2027-09-01T00:00:00.000Z.",
    );
    process.exit(1);
    break;
  case "lapsed":
    console.error(
      `check-security-txt-expiry: ${FILE} EXPIRED on ${expires} (${-daysLeft} days\n` +
        "  ago). A conforming consumer ignores an expired file, so the published\n" +
        "  security contact is currently not published at all.\n" +
        remedy,
    );
    process.exit(1);
    break;
  case "warn":
    // A warning, not a failure: there is still time, and the point of the window
    // is that the owner hears about it while the deadline is comfortably away.
    console.warn(
      `check-security-txt-expiry: ${FILE} expires on ${expires} — ${daysLeft} days\n` +
        `  left, inside the ${WARN_WITHIN_DAYS}-day notice window.\n` +
        remedy,
    );
    break;
  default:
    console.log(
      `check-security-txt-expiry: ${FILE} is valid until ${expires} (${daysLeft} days left)`,
    );
}

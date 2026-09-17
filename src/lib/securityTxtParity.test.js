import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findTags } from "../../tools/shared/html-tags.mjs";
import { parseSecurityTxt } from "../../tools/shared/security-txt.mjs";

// public/.well-known/security.txt is the machine-readable half of SECURITY.md:
// the same contacts, published where a researcher's tooling looks first. Nothing
// else binds the two, so a contact address, policy URL or origin can drift on one
// side and leave the other pointing somewhere nobody reads. This pins them by
// reading the files, mirroring shareIdParity.test.js / limitsParity.test.js.
//
// Only edit-driven drift is asserted here, because this suite is in the gate.
// The one property that changes on its own — whether Expires has passed — is
// checked by tools/check-security-txt-expiry.mjs in the non-gating links
// workflow, so the calendar can never redden an unrelated deploy.

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const securityTxt = read("../../public/.well-known/security.txt");
const securityMd = read("../../SECURITY.md");
const html = read("../../index.html");

// Parsed at module scope by the shared reader, so a malformed line throws and
// fails the whole suite — the right blast radius for a file no consumer will
// parse leniently. The parser itself is tested in tools/shared/securityTxt.test.js.
const declared = parseSecurityTxt(securityTxt);

describe("public/.well-known/security.txt", () => {
  test("carries every field RFC 9116 requires or expects", () => {
    // Contact and Expires are the two the RFC requires; the rest are what makes
    // the file useful to someone who finds it.
    for (const name of [
      "Contact",
      "Expires",
      "Canonical",
      "Policy",
      "Preferred-Languages",
    ]) {
      expect(declared.has(name), `security.txt declares no ${name}`).toBe(true);
    }
  });

  test("offers GitHub private vulnerability reporting alongside the mailto", () => {
    // Two routes on purpose: the advisory form is the preferred one in
    // SECURITY.md, so a machine-readable file offering only email would send a
    // reporter down the path the prose deprioritises.
    const contacts = declared.get("Contact");
    expect(contacts.some((value) => value.startsWith("mailto:"))).toBe(true);
    expect(
      contacts.some((value) =>
        /^https:\/\/github\.com\/.+\/security\/advisories\/new$/.test(value),
      ),
    ).toBe(true);
  });

  test("gives the contact address SECURITY.md gives", () => {
    // Two surfaces telling a reporter where to write, bound so they can't drift:
    // the prose policy is the source, this file the machine-readable copy.
    const [mailto] = declared
      .get("Contact")
      .filter((value) => value.startsWith("mailto:"));
    expect(mailto, "security.txt declares no mailto: Contact").toBeTruthy();
    const address = mailto.slice("mailto:".length);
    expect(
      securityMd.includes(`<${address}>`),
      `SECURITY.md does not give ${address} as the reporting address`,
    ).toBe(true);
  });

  test("points at SECURITY.md as its policy", () => {
    const [policy] = declared.get("Policy");
    expect(policy).toMatch(/\/SECURITY\.md$/);
  });

  test("declares a Canonical on the origin index.html calls canonical", () => {
    // Bound to the page's canonical link so the origin is stated once. A
    // Canonical naming someone else's origin is how a security.txt gets used to
    // redirect reports.
    const [canonicalLink] = findTags(html, "link", { rel: "canonical" });
    const origin = new URL(canonicalLink.attrs.get("href")).origin;
    expect(declared.get("Canonical")[0]).toBe(
      `${origin}/.well-known/security.txt`,
    );
  });
});

describe("SECURITY.md", () => {
  test("points back at the machine-readable file", () => {
    // The other direction: a reader of the prose policy should learn the RFC 9116
    // file exists, and at the URL the file itself claims is canonical.
    const [canonical] = declared.get("Canonical");
    expect(
      securityMd.includes(`<${canonical}>`),
      `SECURITY.md does not link ${canonical}`,
    ).toBe(true);
  });
});

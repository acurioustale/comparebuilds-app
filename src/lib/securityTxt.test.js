import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findTags } from "../../tools/html-tags.mjs";

// public/.well-known/security.txt is the machine-readable half of SECURITY.md:
// the same contacts, published where a researcher's tooling looks first. Nothing
// else binds the two, so a contact address, policy URL or origin can drift on one
// side and leave the other pointing somewhere nobody reads. This pins them by
// reading the files, mirroring shareIdParity.test.js / limitsParity.test.js.

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const securityTxt = read("../../public/.well-known/security.txt");
const securityMd = read("../../SECURITY.md");
const html = read("../../index.html");

// The fields of an RFC 9116 file: `Name: value` lines, with `#` comments and
// blank lines ignored. A name may repeat (two Contact lines here), so collect
// every value per name rather than keeping the last.
function fields(text) {
  const found = new Map();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z-]+):\s*(.+)$/);
    // Parsed at module scope, so a malformed line has to throw rather than
    // assert — it fails the whole suite, which is the right blast radius for a
    // file no consumer will parse leniently.
    if (!match)
      throw new Error(
        `security.txt line is not a "Name: value" field: ${line}`,
      );
    found.set(match[1], [...(found.get(match[1]) ?? []), match[2]]);
  }
  return found;
}

const declared = fields(securityTxt);

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

  test("has not expired", () => {
    // An expired file is invalid per RFC 9116, so this is a real failure rather
    // than a reminder — and the fix is to edit the one line and push.
    const [expires] = declared.get("Expires");
    const when = new Date(expires);
    expect(
      Number.isNaN(when.getTime()),
      `Expires is not a valid timestamp: ${expires}`,
    ).toBe(false);
    expect(
      when > new Date(),
      `security.txt expired on ${expires} — set a new Expires no more than a year out`,
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

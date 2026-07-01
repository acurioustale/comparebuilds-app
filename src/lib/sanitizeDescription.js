/**
 * sanitizeDescription.js
 *
 * Allowlist HTML sanitiser for talent tooltip descriptions.
 *
 * Talent descriptions are rendered with `dangerouslySetInnerHTML` (see
 * TalentTree.jsx), so they must be trusted HTML. They originate from whatever
 * data source the ingest pulls from. To keep the committed data files safe
 * REGARDLESS of source, every HTML-rendered description is run through this
 * sanitiser at ingest time (scripts/ingestBlizzard.js). The committed JSON is
 * therefore the security boundary: the app renders it without trusting upstream.
 */

import DOMPurify from "dompurify";

let purifyInstance = null;

/**
 * `uponSanitizeAttribute` hook: restrict inline `style` to a safe color /
 * font-weight allowlist, dropping the attribute entirely when nothing survives.
 * Registered ONCE on the private instance below (see `sanitizeDescription`), not
 * per call.
 *
 * @param {Node} node  The DOM node being sanitised (unused; required by the hook signature).
 * @param {{ attrName: string, attrValue: string, keepAttr: boolean }} data  Attribute hook data, mutated in place.
 */
function restrictStyleAttribute(node, data) {
  if (data.attrName !== "style") return;
  const style = data.attrValue;
  const decls = [];
  for (const part of style.split(";")) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    const prop = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim();
    if (prop !== "color" && prop !== "font-weight") continue;
    if (prop === "font-weight" && !/^(bold|normal|[1-9]00)$/i.test(value))
      continue;
    if (
      prop === "color" &&
      !/^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%]+\))$/.test(
        value,
      )
    )
      continue;
    decls.push(`${prop}:${value}`);
  }
  if (decls.length > 0) {
    data.attrValue = decls.join(";");
  } else {
    data.keepAttr = false;
  }
}

/**
 * Sanitise an HTML-rendered description into trusted markup.
 *
 * @param {*} input  Description string. Non-strings (e.g. `null` for choice
 *                   nodes) are returned unchanged.
 * @returns {*}      Sanitised HTML string, or the input untouched if not a string.
 */
export function sanitizeDescription(input) {
  if (typeof input !== "string") return input;

  if (!purifyInstance) {
    // Build a DEDICATED DOMPurify instance in both environments (via the
    // DOMPurify(window) factory) rather than reusing the shared default. The
    // style hook is then registered exactly once, on this private instance, so
    // it can never leak into — nor `removeAllHooks` clobber hooks on — a global
    // DOMPurify that other browser code might share. In Node (ingest, tests) the
    // instance is built over a jsdom window; in the browser over the real one.
    let win;
    if (typeof window === "undefined") {
      // eslint-disable-next-line no-undef
      const { JSDOM } = require("jsdom");
      win = new JSDOM("").window;
    } else {
      win = window;
    }
    purifyInstance = DOMPurify(win);
    purifyInstance.addHook("uponSanitizeAttribute", restrictStyleAttribute);
  }

  // We only allow <br>, <b>, and <i> tags.
  return purifyInstance
    .sanitize(input, {
      ALLOWED_TAGS: ["b", "i", "br", "#text"],
      ALLOWED_ATTR: ["style"],
    })
    .replace(/<br>/gi, "<br />"); // canonicalize br
}

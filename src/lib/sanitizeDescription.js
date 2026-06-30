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

/**
 * Sanitise an HTML-rendered description into trusted markup.
 *
 * @param {*} input  Description string. Non-strings (e.g. `null` for choice
 *                   nodes) are returned unchanged.
 * @returns {*}      Sanitised HTML string, or the input untouched if not a string.
 */
export function sanitizeDescription(input) {
  if (typeof input !== "string") return input;

  let purify;
  if (typeof window === "undefined") {
    // In a Node environment (like ingestBlizzard.js or tests), we need jsdom.
    // eslint-disable-next-line no-undef
    const { JSDOM } = require("jsdom");
    const window = new JSDOM("").window;
    purify = DOMPurify(window);
  } else {
    // Browser environment
    purify = DOMPurify;
  }

  // Set up purify hook to restrict styles to only color and font-weight
  purify.addHook("uponSanitizeAttribute", function (node, data) {
    if (data.attrName === "style") {
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
  });

  // We only allow <br>, <b>, and <i> tags.
  const result = purify
    .sanitize(input, {
      ALLOWED_TAGS: ["b", "i", "br", "#text"],
      ALLOWED_ATTR: ["style"],
    })
    .replace(/<br>/gi, "<br />"); // canonicalize br

  purify.removeAllHooks(); // Clean up hook
  return result;
}

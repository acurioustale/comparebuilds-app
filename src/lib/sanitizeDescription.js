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

import { createRequire } from "node:module";

import DOMPurify from "dompurify";

let purifyInstance = null;

// Allowlisted CSS named colors. A bare `[a-zA-Z]+` alternative would let any
// identifier ("expression", "attr", …) through as a "color"; restrict to real
// keywords instead. No named color appears in the committed data today, so this
// is deliberately a small, common set — extend it if a tooltip ever needs more.
const NAMED_COLORS = new Set([
  "black",
  "silver",
  "gray",
  "grey",
  "white",
  "maroon",
  "red",
  "purple",
  "fuchsia",
  "green",
  "lime",
  "olive",
  "yellow",
  "navy",
  "blue",
  "teal",
  "aqua",
  "cyan",
  "magenta",
  "orange",
  "gold",
  "brown",
  "pink",
  "transparent",
  "currentcolor",
]);

// Functional / hex color forms accepted alongside the named-color allowlist.
const COLOR_VALUE_RE =
  /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%]+\))$/;

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
      !COLOR_VALUE_RE.test(value) &&
      !NAMED_COLORS.has(value.toLowerCase())
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
      // Node (ingest, tests): jsdom supplies the DOM. A bare `require` is not
      // defined in an ESM module (this project is "type": "module") — it threw
      // ReferenceError under plain `node`, and only worked because Vitest injects
      // a require shim — so derive one from the module URL. jsdom is a
      // devDependency reached only on this Node path; the browser bundle never
      // imports this file, so at runtime it always takes the `window` branch.
      const require = createRequire(import.meta.url);
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

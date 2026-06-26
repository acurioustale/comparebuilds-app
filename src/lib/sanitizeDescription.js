/**
 * sanitizeDescription.js
 *
 * Allowlist HTML sanitiser for talent tooltip descriptions.
 *
 * Talent descriptions are rendered with `dangerouslySetInnerHTML` (see
 * TalentTree.jsx), so they must be trusted HTML. They originate from whatever
 * data source the ingest pulls from. To keep the committed data files safe
 * REGARDLESS of source, every HTML-rendered description is run through this
 * sanitiser at ingest time (scripts/ingestIcyVeins.js). The committed JSON is
 * therefore the security boundary: the app renders it without trusting upstream.
 *
 * SCOPE — this covers exactly the fields that are rendered as HTML:
 *   - node.description, choice[].description, apex rank[].description.
 * Those are the only `dangerouslySetInnerHTML` sinks in the app, and the only
 * fields the ingest sanitises. Other description fields in the data
 * (spec.description, heroSubtrees.{left,right}.description, and the spec
 * descriptions in classes.json) are SHORT PLAIN-TEXT blurbs and are NOT
 * sanitised — they are safe only because nothing renders them as HTML. If you
 * ever surface one of them, render it as text (`{value}`, which React escapes)
 * — do NOT pass it to dangerouslySetInnerHTML, or run it through this sanitiser
 * first.
 *
 * Strategy — escape by default. The input is split into tag-like tokens and the
 * text between them. Text is always HTML-escaped. A tag survives ONLY if it
 * matches one of a few strictly-shaped allowlist patterns (`<br>`, `<b>`,
 * `</b>`, `<i>`, `</i>`, and `<b style="…">` carrying only a `color` and/or
 * `font-weight` declaration). Anything else — `<script>`,
 * `<img onerror=…>`, event-handler attributes, `javascript:` URLs, unknown tags
 * — is escaped into inert text. Because escaping is the default and only known
 * safe token shapes pass through, there is no tag or attribute an attacker can
 * smuggle past it.
 *
 * The real game markup we have observed is limited to `<br />`, `<b>` and
 * `<b style="color:white;">`; this allowlist covers it, with `<i>` for headroom.
 */

const ESCAPE = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ESCAPE[c]);
}

// Only `color` and `font-weight` declarations survive, and only with a value
// drawn from a safe character set (named colours, #hex, rgb()/hsl(), numbers,
// keywords). url(), expression() and javascript: can never pass.
function sanitizeStyle(style) {
  const decls = [];
  for (const part of style.split(";")) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    const prop = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim();
    if (prop !== "color" && prop !== "font-weight") continue;
    if (!/^[a-zA-Z0-9#(),.%\s]+$/.test(value)) continue;
    if (/url|expression|javascript/i.test(value)) continue;
    decls.push(`${prop}:${value}`);
  }
  return decls.join(";");
}

// Returns a canonical safe tag if `tag` matches the allowlist exactly, otherwise
// the tag escaped into inert text.
function sanitizeTag(tag) {
  const t = tag.trim();
  if (/^<br\s*\/?>$/i.test(t)) return "<br />";
  if (/^<b\s*>$/i.test(t)) return "<b>";
  if (/^<\/b\s*>$/i.test(t)) return "</b>";
  if (/^<i\s*>$/i.test(t)) return "<i>";
  if (/^<\/i\s*>$/i.test(t)) return "</i>";

  const styled = t.match(/^<b\s+style="([^"]*)">$/i);
  if (styled) {
    const safe = sanitizeStyle(styled[1]);
    return safe ? `<b style="${safe}">` : "<b>";
  }

  return escapeHtml(tag);
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

  let out = "";
  let last = 0;
  const tagLike = /<[^>]*>/g;
  let m;
  while ((m = tagLike.exec(input)) !== null) {
    out += escapeHtml(input.slice(last, m.index));
    out += sanitizeTag(m[0]);
    last = tagLike.lastIndex;
  }
  out += escapeHtml(input.slice(last));
  return out;
}

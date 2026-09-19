// Shared HTML tag/attribute scanner. Anything that validates markup needs to
// find a tag by name and read an attribute off it — a policy out of a <meta>, a
// declared image dimension, an inline script's type, a theme colour. Written
// once per caller, each grows its own `<tag …>` regex plus a per-attribute
// `attr=["']…["']` extraction, so the quoting, comment and attribute-boundary
// rules end up in many places and drift (a `>` inside a value truncating a tag,
// `data-name` satisfying a query for `name`, a `<meta` boundary matching
// `<metadata>`). This parses each tag's attributes once, correctly, so those
// rules have one home.
//
// Dependency-free on purpose: a small scan over our own well-formed markup, not
// a general HTML parser. Comment-skipping is shared with ./html-comments.mjs.
import { isCommented } from "./html-comments.mjs";

// A tag's attribute text as Map(lower-cased name → value). A value is unwrapped
// from its quotes (single or double, and may span newlines); an unquoted value
// is taken verbatim; a boolean attribute with no value maps to "". Because the
// names are tokenised, `data-name` becomes the key "data-name" and can never be
// read as "name" — the attribute-boundary bug is structurally impossible here.
// A duplicated attribute keeps the FIRST occurrence, as the HTML parser does
// ("create an element": a later duplicate name is dropped). Reading the last
// would let a guard judge a tag on a value the browser never sees — e.g. the
// meta CSP off `content="…" content="…"`, or a script's executability off
// `type="module" type="application/ld+json"` — so first-wins here matches
// parseCsp's first-wins over duplicate directives and the first-live-tag rule.
export function parseAttrs(attrText) {
  const attrs = new Map();
  // name, then an optional `= value` where value is double-quoted, single-quoted
  // or a bare run. The name class excludes whitespace, `=` and the `/` of a
  // self-closing `/>`, so a lone `/` yields no spurious attribute.
  const ATTR = /([^\s/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]*))?/g;
  for (const [, name, raw] of attrText.matchAll(ATTR)) {
    let value = "";
    if (raw !== undefined) {
      // Unwrap only a genuinely quoted token — one that both opens and closes
      // with the same quote. A value that merely starts with a quote but never
      // closes it (a malformed `foo="bar`) falls through the regex to the
      // bare-run branch; slicing that as if it were quoted would chop its last
      // character too, so keep it verbatim instead.
      const q = raw[0];
      const quoted =
        (q === '"' || q === "'") && raw.length >= 2 && raw.at(-1) === q;
      value = quoted ? raw.slice(1, -1) : raw;
    }
    const key = name.toLowerCase();
    if (!attrs.has(key)) attrs.set(key, value);
  }
  return attrs;
}

// A tag-name boundary: whitespace, `/` or `>` — the only things that can end an
// element name in HTML — as a zero-width lookahead. It rejects both a longer word
// name (`<metadata>`, which a `\b` also rejected) and a hyphenated custom element
// (`<meta-data>`, which a `\b` wrongly accepted since `-` is a word boundary). One
// home for the rule, so the open-tag, close-tag and opener scans can't drift.
const NAME_BOUNDARY = "(?=[\\s/>])";

// The open-tag pattern for `name`: `<name` at a name boundary, through the closing
// `>`. Every quote is one of two things and never both: it opens a span that
// closes before this tag's `>`, or it is a stray with no partner before that `>`
// and counts as a literal char — as a browser tokenizes an unbalanced quote in an
// unquoted value (`content=12"00`). Both branches stop at `>`, so they are exactly
// complementary, which is what keeps the scan linear: no quote is a fork the
// engine can revisit, and a start tag that never closes fails fast instead of
// hanging the guard. With an overlapping fallback (a bare `["']`) every quote is
// such a fork, and a truncated file or an unterminated attribute backtracks
// exponentially — quadrupling per four added quotes, 32 quotes already costing
// 64ms and 40 costing seconds — so the guard hangs instead of failing closed.
//
// The trade both bounds buy: a `>` inside a quoted value now ends the tag. That
// is deliberate. Unbounded, one stray quote pairs with a quote in a LATER tag and
// quietly swallows everything between them — the whole rest of a document's
// <meta> tags, with the guard reading what survives and still exiting 0. Bounded,
// a `>` in a value truncates exactly one tag and surfaces loudly as a missing
// attribute ("declares no og:image"). No quoted value in either repo's markup
// contains a `>`. Revisit when a real attribute value needs one — prose like
// `A > B` in a meta description is the plausible way that happens — and the
// answer then is tokenising, not a longer regex.
// Capture group 1 is the attribute text. `name` is always a literal element name
// from our own callers, so it needs no regex escaping.
function openTag(name) {
  const attrChar = `[^>"']|"[^">]*"|'[^'>]*'|"(?![^">]*")|'(?![^'>]*')`;
  return `<${name}${NAME_BOUNDARY}((?:${attrChar})*)>`;
}

// The close tag for a raw-text element: `</name`, name-boundary anchored, then
// trailing junk before `>` (`</script >`, `</script/>`) as browsers tolerate.
// Shared by rawTextElements (to bound a body) and countRawTextOpeners (to skip
// one), so the two agree on where an element ends.
function closeTag(name) {
  return `</${name}${NAME_BOUNDARY}[^>]*>`;
}

// Every <name …> tag in `html`, in document order, as { raw, attrs }. A tag
// inside an HTML comment (a stale example kept for reference) is skipped, so a
// caller reading the first match binds to the live tag.
export function* htmlTags(html, name) {
  for (const m of html.matchAll(new RegExp(openTag(name), "gi"))) {
    if (isCommented(html, m.index)) continue;
    yield { raw: m[0], attrs: parseAttrs(m[1]) };
  }
}

// htmlTags narrowed to tags whose attributes include every name/value pair in
// `query`, compared case-insensitively (HTML attribute matching is not
// case-sensitive, and no regex escaping is needed since parsed values compare as
// literal strings). An empty query yields every <name> tag.
export function* findTags(html, name, query = {}) {
  const wanted = Object.entries(query).map(([k, v]) => [
    k.toLowerCase(),
    v.toLowerCase(),
  ]);
  for (const tag of htmlTags(html, name)) {
    if (wanted.every(([k, v]) => tag.attrs.get(k)?.toLowerCase() === v)) {
      yield tag;
    }
  }
}

// Like htmlTags but for a raw-text element that carries a body (script): also
// yields `body`, the text between the open and close tags. The close tag anchors
// its name to a boundary char, so `</script-oops>` (or `</scriptx>`) is not read
// as the close — a browser keeps the element open there. An element whose start
// tag sits inside an HTML comment is skipped, as in htmlTags and in the opener
// scan below: a commented-out `<script>` never executes, so the CSP guard must
// neither demand a hash for it nor read it as a count divergence.
export function* rawTextElements(html, name) {
  const re = new RegExp(`${openTag(name)}([\\s\\S]*?)${closeTag(name)}`, "gi");
  for (const m of html.matchAll(re)) {
    if (isCommented(html, m.index)) continue;
    yield { raw: m[0], attrs: parseAttrs(m[1]), body: m[2] };
  }
}

// A whole tag (any name) or an HTML comment anchored at the current `<`, quotes
// balanced so an inner `>` doesn't end it early. Used to step over everything
// that is NOT a `<name` opener — other elements and comments — so a `<name`
// literal sitting inside their markup (a `<script` in a `<meta content="…">`
// value, or in a `<!-- … -->`) is walked past, not read as an opener. It omits
// openTag's lone-`["']` fallback on purpose: a start tag with an unbalanced
// quote fails to match here, so it falls to the opener/stray branches rather
// than being consumed as a well-formed tag.
const TAG_OR_COMMENT =
  /<!--[\s\S]*?-->|<\/?[a-zA-Z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/y;

// How many `<name` start-tag openers `html` contains, counted on the same basis
// rawTextElements consumes them. The scan walks the document `<` by `<`: an
// opener is counted and its raw-text body (up to the next close tag) skipped;
// any other well-formed tag or comment is stepped over whole; a stray `<` that
// starts neither advances one char. So a `<name` literal inside another
// element's attribute value or body (a `<script>` in a JSON-LD block or in
// another script's source), or inside a comment, is not miscounted as its own
// opener. This shares the boundary and close-tag rules above, so a guard can
// assert "every opener parsed into an element" without re-deriving the `<name`
// regex and drifting from it. An opener that forms no element — an unclosed
// `<script>` with no `</script>`, or a start tag too malformed for
// rawTextElements to parse — is still counted here, exactly the divergence a
// fail-closed guard wants to catch.
export function countRawTextOpeners(html, name) {
  const opener = new RegExp(`<${name}${NAME_BOUNDARY}`, "iy");
  const close = new RegExp(closeTag(name), "gi");
  let count = 0;
  let pos = 0;
  for (;;) {
    const lt = html.indexOf("<", pos);
    if (lt < 0) break;
    opener.lastIndex = lt;
    TAG_OR_COMMENT.lastIndex = lt;
    const tag = TAG_OR_COMMENT.exec(html);
    if (opener.test(html)) {
      count += 1;
      // Raw text ends at the next close tag (a browser closes a raw-text element
      // at the first `</name`), so seek the next opener past it; no close → EOF.
      // A malformed start tag matched nothing above, so skip from just past `<`.
      close.lastIndex = lt + (tag ? tag[0].length : 1);
      const c = close.exec(html);
      pos = c ? close.lastIndex : html.length;
    } else if (tag) {
      // A well-formed other tag or a comment: step over it whole so a `<name`
      // in its attribute value or body isn't seen as an opener.
      pos = lt + tag[0].length;
    } else {
      // A stray `<` that starts no tag: advance past it.
      pos = lt + 1;
    }
  }
  return count;
}

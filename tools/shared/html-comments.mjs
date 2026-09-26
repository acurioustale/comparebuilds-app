// Shared HTML-comment membership test. The tag scan in ./html-tags.mjs skips a
// tag kept as a commented-out example above the live one, so anything reading
// the first live <meta> or <script> binds to the real tag rather than to a stale
// sample. The logic lives here once instead of by hand in each caller.
//
// Dependency-free on purpose: a small scan over our own well-formatted markup,
// not a general HTML parser.

// A whole HTML comment, as regex source. Comments can't nest, so the first
// comment end closes each one, exactly as the browser tokenizer does — hence the
// non-greedy body. That end is `-->` or the erroneous `--!>`, and an empty
// `<!-->` or `<!--->` closes at once: the tokenizer ends a comment on all four,
// so a scan that knew only `-->` would read live markup after them as still
// commented out. Exported so ./html-tags.mjs steps over comments by the same
// rule rather than a second copy of it.
export const COMMENT = "<!--(?:-?>|[\\s\\S]*?--!?>)";

// At the current `<`, either a whole HTML comment or a whole tag (any name,
// quotes balanced so an inner `>` doesn't end it early). Group 1 is a comment,
// group 2 a start tag's name.
const COMMENT_OR_TAG = new RegExp(
  `(${COMMENT})|<(?:\\/[a-zA-Z]|([a-zA-Z][^\\s/>]*))[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>`,
  "y",
);

// Elements whose body is text, not markup: a `<!--` inside a script or a title
// is a string, never a comment, so the scan jumps to the element's close tag.
const TEXT_ELEMENTS = new Set(["script", "style", "title", "textarea"]);

// Whether the character at `index` in `html` sits inside an HTML comment.
//
// This walks the document `<` by `<` as the browser tokenizer reads it, rather
// than matching `<!-- ... -->` anywhere in the text. A plain match paired a
// `<!--` that sat in content — an attribute value, a script string — with the
// next real `-->`, and treated every live tag in between as commented out, so
// the guards reading them silently skipped them. Here a comment opens only where
// the browser would open one: a whole tag is stepped over with its attribute
// values, and a text element's body up to its close tag, so a `<!--` inside
// either is never seen. A `<!--` with no matching `-->` hides nothing: an
// unbalanced marker must not make live markup disappear from a guard.
export function isCommented(html, index) {
  let pos = 0;
  while (pos <= index) {
    const lt = html.indexOf("<", pos);
    if (lt < 0 || lt > index) break;
    COMMENT_OR_TAG.lastIndex = lt;
    const m = COMMENT_OR_TAG.exec(html);
    if (!m) {
      // A stray `<` that starts neither a comment nor a tag: advance past it.
      pos = lt + 1;
      continue;
    }
    const end = lt + m[0].length;
    if (m[1]) {
      if (index < end) return true;
      pos = end;
      continue;
    }
    // The tag itself is live; so is anything inside it, and inside a text
    // element's body, since no comment can open there.
    if (index < end) return false;
    pos = end;
    const name = m[2]?.toLowerCase();
    if (TEXT_ELEMENTS.has(name)) {
      const close = new RegExp(`</${name}(?=[\\s/>])`, "gi");
      close.lastIndex = end;
      const c = close.exec(html);
      if (!c || index < c.index) return false;
      pos = c.index;
    }
  }
  return false;
}

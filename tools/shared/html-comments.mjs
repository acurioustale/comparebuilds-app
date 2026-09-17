// Shared HTML-comment membership test. The tag scan in ./html-tags.mjs skips a
// tag kept as a commented-out example above the live one, so anything reading
// the first live <meta> or <script> binds to the real tag rather than to a stale
// sample. The logic lives here once instead of by hand in each caller.
//
// Dependency-free on purpose: a small regex over our own well-formatted markup,
// not a general HTML parser.

// A whole HTML comment span. Comments can't nest, so the first `-->` closes each
// one, exactly as the browser tokenizer does — hence the non-greedy body.
const COMMENT = /<!--[\s\S]*?-->/g;

// Whether the character at `index` in `html` sits inside an HTML comment.
//
// This scans real `<!-- ... -->` spans rather than the positional heuristic it
// replaces (`lastIndexOf("<!--") > lastIndexOf("-->")` over the text before the
// tag). That heuristic was fooled by a lone `<!--` literal appearing in content
// — a JSON-LD string, an attribute value — with no closing `-->`: it treated
// every following tag as commented and dropped the live <meta>/CSP from the
// guards that read them. Requiring a matched close means an unbalanced marker in
// content no longer hides live markup.
export function isCommented(html, index) {
  for (const m of html.matchAll(COMMENT)) {
    // Matches are in document order, so once one starts past the tag none can
    // contain it.
    if (m.index > index) break;
    if (index < m.index + m[0].length) return true;
  }
  return false;
}

// Shared inline-<script> extractor. Anything that hashes or inspects the inline
// scripts of a page must agree with every other caller on exactly which scripts
// exist — one script missed from the enumeration ships unhashed and slips past a
// CSP check. So the selection lives here, as a tested unit, instead of as a
// private regex in each caller.
//
// Built on the shared scanner in ./html-tags.mjs: it finds the <script>
// elements (quote-aware, tolerating close-tag junk) and parses each one's
// attributes, so the fiddly tag/attribute rules live in one place.
import { rawTextElements } from "./html-tags.mjs";

// Every <script> element in the given HTML, in document order, as
// { raw, attrs, body }: attrs is the parsed attribute Map, body its contents.
export function scriptElements(html) {
  return [...rawTextElements(html, "script")];
}

// The inline-vs-external test for a single parsed <script> element: inline means
// no src attribute. External scripts carry no inline body to hash or inspect and
// are covered by script-src 'self'.
//
// Presence of the parsed `src` key is the whole test: a `src=` sitting inside
// another attribute's value can't be mistaken for one (it isn't a top-level
// attribute), and `data-src`/`x-src` are distinct keys — so a genuine inline
// script is never dropped from enumeration and shipped unhashed. A valueless
// `<script src>` (which fetches the current page rather than executing inline)
// counts as external too, same as `src=""`. Exported as a predicate so a caller
// that already has the parsed element list (the CSP guard, which also needs the
// element count) can select inline scripts without re-scanning the markup.
export function isInlineScript({ attrs }) {
  return !attrs.has("src");
}

// Inline scripts only, scanned straight from HTML.
export function inlineScripts(html) {
  return scriptElements(html).filter(isInlineScript);
}

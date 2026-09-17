// Shared light-dark() palette parser. A stylesheet that themes itself with
// `--token: light-dark(<light>, <dark>)` custom properties is the single place
// its colours are written down, so every guard that binds another surface to
// those colours — a <meta name="theme-color"> per prefers-color-scheme, a web
// app manifest's theme/background colour, a hand-copied fallback palette for
// browsers without light-dark() — needs to read the token pair back out. Written
// once per caller, each grows its own `light-dark\((#[0-9a-f]{3,8}), …\)` regex,
// so the hex-length, whitespace, comment and cascade rules end up in several
// places and drift. This parses the declarations once, correctly, so those rules
// have one home.
//
// Dependency-free on purpose: a small scan over our own palette blocks, not a
// general CSS parser.

// A CSS hex colour, and only a valid length: #rgb, #rgba, #rrggbb, #rrggbbaa.
// `{3,8}` would also accept 5- and 7-digit hex, so a typo like `#12345` (a
// dropped digit) would parse as a valid token and propagate to the drift guards
// as the intended colour. Longest length first so a too-long run can't
// partial-match a shorter valid prefix; an invalid length then fails to match
// here and is caught by the completeness check below.
const HEX = "#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})";

// A functional colour notation — `rgb(255 250 238 / 92%)`, `hsl(30, 40%, 90%)`,
// `oklch(…)`. A palette that needs a translucent value can't write it as hex
// without losing the channel syntax, so these are parsed rather than rejected:
// the alternative is the completeness check below hard-failing on a legitimate
// palette entry, which would push callers back to a private regex — exactly what
// this module exists to prevent. The function names are an explicit list, not
// `[a-z]+`, so a non-colour function (`var(--other)`, a `color-mix()` whose
// operands this does not resolve) still fails loudly instead of being handed to
// a guard as if it were a colour. The body excludes parens, so it can neither
// nest nor run past its own `)` into the rest of the declaration.
const FN = "(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\([^()]*\\)";

// Either colour form. Hex first: it is what a palette normally holds, and the
// two forms are disjoint, so the order is only about the common case.
const COLOR = `(?:${HEX}|${FN})`;

// Sticky (`y`) so it matches only at the offset it's anchored to, not the next
// declaration further down: the completeness loop below points it at each
// `light-dark(` declaration in turn and treats a non-match as an unparseable
// value, so a token redeclared with an unparseable value can't be waved through
// just because an earlier good declaration of the same token parsed.
// `\s*` before the colon too: CSS permits whitespace between a property name and
// its colon (`--x : light-dark(...)`), so a declaration written that way must
// still parse. Without it the token matched neither pattern and was dropped from
// the map silently — the drift guards that read the map would then stop checking
// that token with no signal. (Prettier normalises the spacing away, so this was
// latent, but the parser must not depend on the formatter having run.)
const LIGHT_DARK = new RegExp(
  `--([\\w-]+)\\s*:\\s*light-dark\\(\\s*(${COLOR})\\s*,\\s*(${COLOR})\\s*\\)`,
  // Case-insensitive, because CSS function and keyword names are: `RGB(...)` is
  // the same colour as `rgb(...)`, and a palette written that way must parse
  // rather than hard-fail. It pairs with the same flag on LIGHT_DARK_DECL below,
  // so the detector and the parser agree on which declarations exist.
  "iy",
);

// The start of a `--token: light-dark(` custom-property declaration, whatever the
// value form. Used only to detect a declaration the value pattern above can't
// parse — see the completeness check below. (`color: light-dark(...)` inside an
// `@supports` test isn't a custom property, so the `--` prefix skips it.) Same
// optional whitespace before the colon as LIGHT_DARK, so the two stay in lockstep
// on a spaced declaration.
const LIGHT_DARK_DECL = /--([\w-]+)\s*:\s*light-dark\(/gi;

// One parsed colour, lower-cased so callers can compare without re-normalising,
// with internal whitespace runs collapsed so the two spacings of an otherwise
// identical functional colour compare equal.
const normalise = (color) => color.toLowerCase().replace(/\s+/g, " ");

// Map(token → { light, dark }) for every light-dark() custom property in `css`.
//
// A value neither pattern recognises (a bare keyword, an unlisted function)
// would otherwise be dropped silently, and the drift guards that read this map
// would then stop checking that token without any signal, green-lighting real
// drift. So refuse to skip quietly: any `--x: light-dark(...)` declaration that
// didn't parse is a hard error telling the maintainer to extend the parser.
export function lightDarkTokens(css) {
  // Strip CSS comments first so a commented-out palette line — an old value kept
  // for reference — is neither parsed into the map nor tripped over by the
  // completeness check below (a commented `--x: light-dark(white, black)` would
  // otherwise hard-fail the build). CSS comments don't nest, so a non-greedy
  // body ends each at its first `*/`, exactly as the CSS tokenizer does. The
  // HTML guards skip comments the same way via ./html-comments.mjs.
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens = new Map();
  // Walk every `--token: light-dark(` declaration in source order and parse it
  // where it sits. Driving the map off the declarations (not off the value
  // matches alone) means a later redeclaration wins — matching the CSS cascade —
  // while the sticky parse still runs on every occurrence, so an unparseable or
  // wrong-length value fails loudly even when an earlier declaration of the same
  // token already parsed. `Map.set` keeps the last write, so tokens holds the
  // colour the browser actually uses.
  for (const decl of src.matchAll(LIGHT_DARK_DECL)) {
    LIGHT_DARK.lastIndex = decl.index;
    const match = LIGHT_DARK.exec(src);
    if (!match) {
      throw new Error(
        `css-tokens: --${decl[1]} uses a light-dark() value that is not two ` +
          `colours this parser recognises; extend lightDarkTokens to parse it ` +
          `so the palette guards keep checking that token instead of silently ` +
          `skipping it`,
      );
    }
    tokens.set(decl[1], {
      light: normalise(match[2]),
      dark: normalise(match[3]),
    });
  }
  return tokens;
}

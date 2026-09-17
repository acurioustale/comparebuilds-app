// Shared readers for the Open Graph share card: what a document declares about
// its card, taken from the markup rather than restated. A card's size lives in
// more than one place — the `og:image:width`/`og:image:height` metas that tell a
// link unfurler how big the image is, and the image that actually gets served —
// and a guard can only bind those two surfaces to each other if it reads each
// one the same way every time. Keeping the extraction here, tested, is what
// makes an og-image guard a binding rather than a third restatement of the
// numbers; the same goes for the card's path, which the og:image meta already
// names and no guard should hardcode a second copy of.
//
// Dependency-free on purpose: the shared tag scanner over our own markup, and a
// direct read of the PNG header — no image library.
import { findTags } from "./html-tags.mjs";

/**
 * What a document declares for ONE og dimension meta, with a missing tag told
 * apart from a present-but-unreadable value. A guard needs the distinction: a
 * dropped meta and a `content="1200px"` are different mistakes, and reporting
 * both as "no meta" points the reader at the wrong line.
 *
 * Reads the first LIVE tag (tags inside an HTML comment are skipped by the
 * shared scanner), matching what an unfurler takes from the document — a
 * previous size kept as a comment is not the declaration.
 *
 * @param {string} html Document markup
 * @param {string} property The meta's `property`, e.g. "og:image:width"
 * @returns {{ present: boolean, raw: string | undefined, value: number | undefined }}
 *   `present` is whether the meta exists at all, `raw` its content attribute as
 *   written, `value` the parsed integer — undefined unless the content is a
 *   bare integer, so a caller can fail loudly rather than compare against NaN.
 */
export function declaredOgDimension(html, property) {
  const [tag] = findTags(html, "meta", { property });
  if (!tag) return { present: false, raw: undefined, value: undefined };
  const raw = tag.attrs.get("content") ?? "";
  // A width is a bare integer; anything else ("", "1200px") is present but not
  // a declaration a guard can bind to.
  const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : undefined;
  return { present: true, raw, value };
}

/**
 * The image dimensions a document advertises through its og:image:width /
 * og:image:height metas. A missing or non-numeric meta yields undefined for that
 * side. The pair-shaped convenience over declaredOgDimension, for a caller that
 * only needs the numbers.
 *
 * @param {string} html Document markup
 * @returns {{ width: number | undefined, height: number | undefined }}
 */
export function declaredOgDimensions(html) {
  return {
    width: declaredOgDimension(html, "og:image:width").value,
    height: declaredOgDimension(html, "og:image:height").value,
  };
}

/**
 * The path of the image a document advertises as its share card, read from the
 * og:image meta. A guard that hardcodes the filename instead keeps validating
 * the old file after the meta is repointed, leaving the newly-advertised one
 * unchecked — the one drift it exists to catch.
 *
 * og:image is an absolute URL per the OG spec, so the path is its pathname; a
 * relative value is tolerated and taken verbatim. The leading slash is stripped,
 * making the result relative to the site (and so to the repo root).
 *
 * @param {string} html Document markup
 * @returns {string | undefined} The path, or undefined if the document declares
 *   no og:image (or declares an empty one, which names no file either).
 */
export function ogImagePath(html) {
  const [tag] = findTags(html, "meta", { property: "og:image" });
  const content = tag?.attrs.get("content");
  if (!content) return undefined;
  let path;
  try {
    path = new URL(content).pathname; // absolute URL → its path
  } catch {
    path = content; // already a relative path
  }
  return path.replace(/^\//, "");
}

/**
 * The pixel dimensions in a PNG's IHDR chunk.
 *
 * @param {Buffer} buf PNG file contents (the first 24 bytes suffice)
 * @returns {{ width: number, height: number }}
 * @throws {Error} if the buffer is not a PNG whose first chunk is IHDR
 */
export function pngDimensions(buf) {
  // PNG: 8-byte signature, then the IHDR chunk (length + type) with width and
  // height as big-endian uint32 at byte offsets 16 and 20.
  const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("not a valid PNG");
  }
  if (buf.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("missing IHDR chunk");
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

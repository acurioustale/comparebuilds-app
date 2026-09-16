// Shared readers for the Open Graph card's dimensions. The card's size is
// declared in more than one place — the `og:image:width`/`og:image:height` metas
// that tell a link unfurler how big the image is, and the image (or renderer)
// that actually produces it — and a reader must agree on what each says before
// the two can be bound to each other. Keeping the extraction here, tested, is
// what makes the og-image guard a binding rather than a third restatement of
// 1200×630.
//
// Dependency-free on purpose: the shared tag scanner over our own markup, and a
// direct read of the PNG header — no image library.
import { findTags } from "./html-tags.mjs";

/**
 * The image dimensions a document advertises through its og:image:width /
 * og:image:height metas. A missing or non-numeric meta yields undefined for that
 * side, so the caller can fail loudly rather than compare against NaN.
 *
 * Reads the first LIVE tag of each (tags inside an HTML comment are skipped by
 * the shared scanner), matching what an unfurler takes from the document.
 *
 * @param {string} html Document markup
 * @returns {{ width: number | undefined, height: number | undefined }}
 */
export function declaredOgDimensions(html) {
  const read = (property) => {
    const [tag] = findTags(html, "meta", { property });
    const raw = tag?.attrs.get("content");
    // A width is a bare integer; anything else (absent, empty, "1200px") is not
    // a declaration this guard can bind to.
    return raw !== undefined && /^\d+$/.test(raw.trim())
      ? Number(raw.trim())
      : undefined;
  };
  return {
    width: read("og:image:width"),
    height: read("og:image:height"),
  };
}

/**
 * The pixel dimensions in a PNG's IHDR chunk.
 *
 * @param {Buffer} buf PNG file contents
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

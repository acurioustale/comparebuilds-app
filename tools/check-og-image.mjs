// Guard the Open Graph share image against the most common drift: a wrong-size
// or missing public/og-image.png. The page declares og:image:width/height as
// 1200x630, so the file must actually be those dimensions. Reads the PNG IHDR
// chunk directly (no image library) and fails on a mismatch. Run from
// validate.sh and deploy.yml.
//
// This does NOT catch content drift — that stays a manual step.
import { readFile } from "node:fs/promises";

const EXPECTED = { width: 1200, height: 630 };
const path = new URL("../public/og-image.png", import.meta.url);

const buf = await readFile(path);

// PNG: 8-byte signature, then the IHDR chunk (length+type) with width and
// height as big-endian uint32 at byte offsets 16 and 20.
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
if (buf.length < 24 || !buf.subarray(0, 8).equals(SIGNATURE)) {
  console.error("check-og-image: public/og-image.png is not a valid PNG");
  process.exit(1);
}

if (buf.subarray(12, 16).toString("ascii") !== "IHDR") {
  console.error("check-og-image: public/og-image.png missing IHDR chunk");
  process.exit(1);
}

const width = buf.readUInt32BE(16);
const height = buf.readUInt32BE(20);

if (width !== EXPECTED.width || height !== EXPECTED.height) {
  console.error(
    `check-og-image: public/og-image.png is ${width}x${height}, expected ${EXPECTED.width}x${EXPECTED.height}`,
  );
  process.exit(1);
}

console.log(`check-og-image: public/og-image.png is ${width}x${height}`);

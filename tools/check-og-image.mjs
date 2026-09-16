// Guard the Open Graph share image against the most common drift: a wrong-size
// or missing public/og-image.png. The page advertises the card's size to link
// unfurlers through its og:image:width/height metas, and an unfurler lays the
// card out from those numbers — so the file must be exactly what the metas
// claim, or previews crop or letterbox.
//
// The expected size is READ FROM index.html rather than restated here. A guard
// holding its own copy of 1200×630 is a third place the number lives: changing
// the metas would leave it asserting the old size, passing while the served
// image and the declaration disagreed. Binding the two surfaces means there is
// only one declaration, and the guard checks the file against it.
//
// This does NOT catch content drift — that stays a manual step. The dynamic
// share card (api/og.php, advertised by api/share.php) is a separate pair, bound
// by tools/ogDimensions.test.js.
import { readFile } from "node:fs/promises";
import { declaredOgDimensions, pngDimensions } from "./og-dimensions.mjs";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const imagePath = new URL("../public/og-image.png", import.meta.url);

const { width: declaredWidth, height: declaredHeight } =
  declaredOgDimensions(html);
if (declaredWidth === undefined || declaredHeight === undefined) {
  console.error(
    "check-og-image: index.html declares no readable og:image:width /\n" +
      "  og:image:height metas, so there is nothing to check the file against.\n" +
      "  An unfurler needs both; restore them rather than dropping the check.",
  );
  process.exit(1);
}

let buf;
try {
  buf = await readFile(imagePath);
} catch {
  console.error("check-og-image: public/og-image.png not found");
  process.exit(1);
}

let actual;
try {
  actual = pngDimensions(buf);
} catch (err) {
  console.error(`check-og-image: public/og-image.png is ${err.message}`);
  process.exit(1);
}

if (actual.width !== declaredWidth || actual.height !== declaredHeight) {
  console.error(
    `check-og-image: public/og-image.png is ${actual.width}x${actual.height}, but index.html\n` +
      `  advertises ${declaredWidth}x${declaredHeight} to link unfurlers`,
  );
  process.exit(1);
}

console.log(
  `check-og-image: public/og-image.png is ${actual.width}x${actual.height}, as index.html advertises`,
);

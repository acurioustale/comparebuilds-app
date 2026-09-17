// api/og.php renders the per-share preview image and api/share.php writes the
// og:image:width/height metas that advertise it. They are two files in two
// languages describing one image, so nothing but a test stops them drifting —
// and a drifted pair means every shared link unfurls to a cropped or
// letterboxed card, which no other check in the gate would see. (The static
// card is the other pair: index.html's metas against the PNG it names, bound by
// tools/check-og-image.mjs.)
//
// This stays here rather than beside the dimension readers in tools/shared/,
// because it is ours alone: the mirrored bundle must be byte-identical in a
// sibling repo that has no PHP API, and a test reaching into ../api/ could
// never be. The readers it would otherwise share are pinned in
// tools/shared/ogDimensions.test.js.
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("dynamic share-card dimension parity", () => {
  const ogPhp = read("../api/og.php");
  const sharePhp = read("../api/share.php");

  const phpVar = (name) => {
    const m = ogPhp.match(new RegExp(`\\$${name}\\s*=\\s*(\\d+)\\s*;`));
    if (!m) throw new Error(`could not find PHP variable $${name} in og.php`);
    return Number(m[1]);
  };

  // share.php emits the metas from PHP string concatenation, not markup a tag
  // scanner can read, so match the emitted literal.
  const emittedMeta = (property) => {
    const m = sharePhp.match(
      new RegExp(`og:image:${property}\\\\"\\s+content=\\\\"(\\d+)\\\\"`),
    );
    if (!m) {
      throw new Error(`could not find the emitted og:image:${property} meta`);
    }
    return Number(m[1]);
  };

  test("share.php advertises the width og.php renders", () => {
    expect(emittedMeta("width")).toBe(phpVar("W"));
  });

  test("share.php advertises the height og.php renders", () => {
    expect(emittedMeta("height")).toBe(phpVar("H"));
  });
});

/**
 * Tests for the icon downloader's response-integrity guards. A truncated or
 * non-JPEG 200 must be rejected (and retried), never written to disk — otherwise
 * the incremental `existsSync` skip would permanently commit a corrupt icon.
 */

import { describe, test, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";

// fetchOne writes via writeFileAtomic (tmp write + rename) and skips via
// fs.existsSync. Mock fs so the test never touches the real
// public/talent-icons/, and capture writes so we can assert whether one
// happened — the rename retargets the captured entry to its final path, so
// assertions see the destination exactly as the incremental skip would.
// vi.hoisted makes `writes` available inside the hoisted mock factory.
const { writes } = vi.hoisted(() => ({ writes: [] }));
vi.mock("fs", () => ({
  existsSync: () => false,
  writeFileSync: (dest, buf) => writes.push({ dest, buf }),
  renameSync: (from, to) => {
    for (const w of writes) if (w.dest === from) w.dest = to;
  },
  unlinkSync: () => {},
  rmSync: () => {},
  mkdirSync: () => {},
  readFileSync: () => "[]",
  readdirSync: () => [],
}));

import { fetchOne } from "./fetchIcons.js";

// Minimal valid JPEG: SOI (ff d8) … EOI (ff d9).
function jpeg(n = 16) {
  const b = Buffer.alloc(n, 0x11);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[n - 2] = 0xff;
  b[n - 1] = 0xd9;
  return b;
}

function mockResponse(body, { contentLength = body.length, encoding } = {}) {
  const headers = new Headers();
  if (contentLength != null)
    headers.set("content-length", String(contentLength));
  if (encoding != null) headers.set("content-encoding", encoding);
  global.fetch = vi.fn(async () => ({
    status: 200,
    ok: true,
    headers,
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  }));
}

const realFetch = global.fetch;
beforeEach(() => {
  writes.length = 0;
});
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("fetchOne integrity guards", () => {
  test("writes a complete JPEG whose length matches Content-Length", async () => {
    mockResponse(jpeg(16));
    const result = await fetchOne("good");
    assert.strictEqual(result, "downloaded");
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].buf.length, 16);
  });

  test("rejects a body shorter than Content-Length and does not write", async () => {
    const cut = jpeg(16).subarray(0, 10); // 10 bytes, but header advertises 16
    mockResponse(cut, { contentLength: 16 });
    await assert.rejects(fetchOne("cut"), /truncated/);
    assert.strictEqual(writes.length, 0);
  });

  test("rejects a 200 that is not a JPEG", async () => {
    // Length matches, so the truncation check passes — the start-marker check
    // must still reject an error page served as 200.
    mockResponse(Buffer.from("<html>not found</html>"));
    await assert.rejects(fetchOne("page"), /not a JPEG/);
    assert.strictEqual(writes.length, 0);
  });

  test("without Content-Length, rejects a body missing the JPEG end marker", async () => {
    const noEoi = Buffer.from([0xff, 0xd8, 0x11, 0x11]); // SOI but no EOI
    mockResponse(noEoi, { contentLength: null });
    await assert.rejects(fetchOne("chunked"), /end marker/);
    assert.strictEqual(writes.length, 0);
  });

  test("treats content-encoding: identity as unencoded and still enforces Content-Length", async () => {
    // A structurally complete-looking JPEG (valid SOI/EOI) that is shorter than
    // the advertised length. `identity` is not compression, so Content-Length is
    // exact and the truncation must be caught rather than skipped — otherwise the
    // valid end marker would let this slip past.
    mockResponse(jpeg(16), { contentLength: 32, encoding: "identity" });
    await assert.rejects(fetchOne("identity"), /truncated/);
    assert.strictEqual(writes.length, 0);
  });

  test("skips the Content-Length check for a real compression encoding", async () => {
    // gzip: fetch has already decompressed the body, so buf.length won't match
    // the compressed Content-Length. A complete JPEG must still be accepted via
    // the end-marker fallback rather than wrongly rejected as truncated.
    mockResponse(jpeg(16), { contentLength: 8, encoding: "gzip" });
    const result = await fetchOne("gzipped");
    assert.strictEqual(result, "downloaded");
    assert.strictEqual(writes.length, 1);
  });
});

import { describe, test, afterEach } from "vitest";
import assert from "node:assert/strict";
import { createServerShare } from "./shareLink.js";

afterEach(() => {
  delete globalThis.fetch;
});

describe("shareLink createServerShare", () => {
  test("submits payload and returns id", async () => {
    let capturedBody = null;
    globalThis.fetch = async (url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ id: "aB3xZ9mK" }),
      };
    };

    const out = await createServerShare({
      classId: 1,
      specId: 1,
      builds: ["CoPAAAA"],
      className: "Mage",
      specName: "Frost",
    });

    assert.deepStrictEqual(out, { id: "aB3xZ9mK" });
    assert.deepStrictEqual(capturedBody, {
      classId: 1,
      specId: 1,
      builds: ["CoPAAAA"],
      className: "Mage",
      specName: "Frost",
    });
  });

  test("throws when a 200 response has no id", async () => {
    // A misconfigured proxy/CDN success page, or an API contract drift, can
    // return 200 with a body missing the id. It must fail loudly, not resolve
    // as a successful share that builds a "/s/undefined" link.
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({}),
    });

    await assert.rejects(
      () =>
        createServerShare({
          classId: 1,
          specId: 1,
          builds: ["CoPAAAA"],
          className: "Mage",
          specName: "Frost",
        }),
      /unexpected response/,
    );
  });

  test("throws when a 200 response id is not a non-empty string", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ id: 12345 }),
    });

    await assert.rejects(
      () =>
        createServerShare({
          classId: 1,
          specId: 1,
          builds: ["CoPAAAA"],
          className: "Mage",
          specName: "Frost",
        }),
      /unexpected response/,
    );
  });

  test("throws when a 200 response body is not valid JSON", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    });

    await assert.rejects(
      () =>
        createServerShare({
          classId: 1,
          specId: 1,
          builds: ["CoPAAAA"],
          className: "Mage",
          specName: "Frost",
        }),
      /unexpected response/,
    );
  });

  test("throws on HTTP error", async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "Custom error" }),
    });

    await assert.rejects(
      async () => {
        await createServerShare({
          classId: 1,
          specId: 1,
          builds: ["CoPAAAA"],
          className: "Mage",
          specName: "Frost",
        });
      },
      (err) => {
        assert.strictEqual(err.message, "Custom error");
        return true;
      },
    );
  });
});

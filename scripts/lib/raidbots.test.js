import { describe, it, expect, vi } from "vitest";
import {
  assertEnvironment,
  fetchRaidbotsJson,
  ENVIRONMENTS,
} from "./raidbots.js";

const ok = (body) => ({ ok: true, status: 200, text: async () => body });

describe("assertEnvironment", () => {
  it("accepts every published channel", () => {
    for (const env of ENVIRONMENTS) expect(assertEnvironment(env)).toBe(env);
  });

  it("rejects an unknown channel", () => {
    // The value becomes a URL path segment and a cache directory name, so an
    // unchecked one both builds a nonsense request and could walk the cache
    // path. A typo must fail loudly instead of 404-ing into a vague error.
    expect(() => assertEnvironment("lve")).toThrow(
      /unknown Raidbots environment/,
    );
    expect(() => assertEnvironment("../../etc")).toThrow(/unknown Raidbots/);
  });
});

describe("fetchRaidbotsJson", () => {
  it("fetches and parses the requested file for the requested channel", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok('{"a":1}'));
    const data = await fetchRaidbotsJson("talents.json", {
      env: "ptr",
      cache: false,
      fetchImpl,
    });
    expect(data).toEqual({ a: 1 });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://www.raidbots.com/static/data/ptr/talents.json",
    );
  });

  it("throws on a non-OK response instead of parsing the error body", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 404, text: async () => "nope" });
    await expect(
      fetchRaidbotsJson("talents.json", { cache: false, fetchImpl }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("throws on a malformed body rather than returning it", async () => {
    // Raidbots serves these from cloud storage, which answers some failures with
    // an XML error document at HTTP 200. Parsing is what proves the body is the
    // JSON we asked for; with caching on, this is also what stops a corrupt copy
    // being written and read back forever after (see the cache-write ordering).
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(ok("<?xml version='1.0'?><Error/>"));
    await expect(
      fetchRaidbotsJson("talents.json", { cache: false, fetchImpl }),
    ).rejects.toThrow();
  });

  it("rejects an unknown channel before issuing any request", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchRaidbotsJson("talents.json", {
        env: "nope",
        cache: false,
        fetchImpl,
      }),
    ).rejects.toThrow(/unknown Raidbots environment/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

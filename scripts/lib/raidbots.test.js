import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  assertEnvironment,
  fetchRaidbotsJson,
  fetchTalents,
  ENVIRONMENTS,
} from "./raidbots.js";

const ok = (body) => ({ ok: true, status: 200, text: async () => body });
const tmpRoot = () => mkdtempSync(join(tmpdir(), "cb-rb-"));

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

describe("content-hash keyed cache", () => {
  it("serves a second read of the same version from disk", async () => {
    const cacheRoot = tmpRoot();
    const fetchImpl = vi.fn().mockResolvedValue(ok('{"v":1}'));
    const opts = { cacheRoot, version: "hash-a", fetchImpl };

    expect(await fetchRaidbotsJson("talents.json", opts)).toEqual({ v: 1 });
    expect(await fetchRaidbotsJson("talents.json", opts)).toEqual({ v: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refetches when the version changes, and drops the superseded copy", async () => {
    // The bug this closes: keyed by channel alone, the entry never expires, so
    // the first day Raidbots publishes a new build every consumer keeps reading
    // yesterday's file and reports agreement it never actually checked.
    const cacheRoot = tmpRoot();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok('{"v":1}'))
      .mockResolvedValueOnce(ok('{"v":2}'));

    await fetchRaidbotsJson("talents.json", {
      cacheRoot,
      version: "hash-a",
      fetchImpl,
    });
    const fresh = await fetchRaidbotsJson("talents.json", {
      cacheRoot,
      version: "hash-b",
      fetchImpl,
    });

    expect(fresh).toEqual({ v: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // These files are multi-megabyte and the old one is never read again.
    expect(readdirSync(join(cacheRoot, "live"))).toEqual(["hash-b"]);
  });

  it("writes nothing when there is no version to key on", async () => {
    // A cache entry with no possible invalidation is worse than a refetch.
    const cacheRoot = tmpRoot();
    const fetchImpl = vi.fn().mockResolvedValue(ok('{"v":1}'));
    await fetchRaidbotsJson("metadata.json", { cacheRoot, fetchImpl });
    await fetchRaidbotsJson("metadata.json", { cacheRoot, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(existsSync(join(cacheRoot, "live"))).toBe(false);
  });

  it("keeps channels separate", async () => {
    const cacheRoot = tmpRoot();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok('{"c":"live"}'))
      .mockResolvedValueOnce(ok('{"c":"ptr"}'));
    const opts = { cacheRoot, version: "same-hash", fetchImpl };
    expect(await fetchRaidbotsJson("talents.json", opts)).toEqual({
      c: "live",
    });
    expect(
      await fetchRaidbotsJson("talents.json", { ...opts, env: "ptr" }),
    ).toEqual({ c: "ptr" });
  });
});

describe("fetchTalents", () => {
  it("resolves the content hash first and keys the cache on it", async () => {
    const cacheRoot = tmpRoot();
    const fetchImpl = vi.fn(async (url) =>
      url.endsWith("metadata.json")
        ? ok('{"contentHash":"abc","wowBuild":"12.1.0.1"}')
        : ok("[]"),
    );

    await fetchTalents({ cacheRoot, fetchImpl });
    await fetchTalents({ cacheRoot, fetchImpl });

    // metadata is re-read each time (it is the freshness probe); the ~3 MB
    // talents payload is fetched once.
    const talentCalls = fetchImpl.mock.calls.filter(([u]) =>
      u.endsWith("talents.json"),
    );
    expect(talentCalls).toHaveLength(1);
    expect(existsSync(join(cacheRoot, "live", "abc", "talents.json"))).toBe(
      true,
    );
  });

  it("falls back to the build number when no content hash is published", async () => {
    const cacheRoot = tmpRoot();
    const fetchImpl = vi.fn(async (url) =>
      url.endsWith("metadata.json") ? ok('{"wowBuild":"12.1.0.1"}') : ok("[]"),
    );
    await fetchTalents({ cacheRoot, fetchImpl });
    expect(
      existsSync(join(cacheRoot, "live", "12.1.0.1", "talents.json")),
    ).toBe(true);
  });
});

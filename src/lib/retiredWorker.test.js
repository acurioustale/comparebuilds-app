import { describe, it, expect } from "vitest";
import {
  isRetiredWorker,
  isRetiredCache,
  RETIRED_WORKER_PATH,
  RETIRED_CACHE_PREFIX,
} from "./retiredWorker.js";

const ORIGIN = "https://comparebuilds.app";

describe("isRetiredWorker", () => {
  it("matches the retired worker however its URL is spelled", () => {
    expect(isRetiredWorker(`${ORIGIN}/sw.js`, ORIGIN)).toBe(true);
    expect(isRetiredWorker("/sw.js", ORIGIN)).toBe(true);
    expect(isRetiredWorker(`${ORIGIN}/sw.js?v=2`, ORIGIN)).toBe(true);
  });

  it("leaves any other worker registered", () => {
    // The defect this exists for: the cleanup unregistered EVERY worker on the
    // origin, so the first caching feature added after it would be torn down on
    // every page load, silently.
    expect(isRetiredWorker(`${ORIGIN}/offline-worker.js`, ORIGIN)).toBe(false);
    expect(isRetiredWorker(`${ORIGIN}/assets/sw.js`, ORIGIN)).toBe(false);
    expect(isRetiredWorker(`${ORIGIN}/sw.js.map`, ORIGIN)).toBe(false);
  });

  it("is false for a missing or unresolvable script URL", () => {
    // A registration with nothing active/waiting/installing yields "".
    expect(isRetiredWorker("", ORIGIN)).toBe(false);
    expect(isRetiredWorker(null, ORIGIN)).toBe(false);
    expect(isRetiredWorker(undefined, ORIGIN)).toBe(false);
    expect(isRetiredWorker("http://", ORIGIN)).toBe(false);
  });

  it("names the path it retires", () => {
    expect(RETIRED_WORKER_PATH).toBe("/sw.js");
  });
});

describe("isRetiredCache", () => {
  it("matches the worker's own cache keys", () => {
    expect(isRetiredCache("zamimg-icons-v2")).toBe(true);
    expect(isRetiredCache("zamimg-meta-v2")).toBe(true);
    expect(isRetiredCache("zamimg-icons-v1")).toBe(true);
  });

  it("leaves every other cache key alone", () => {
    // Same defect on the Cache Storage side: keys() was swept unfiltered.
    expect(isRetiredCache("talent-icons-v1")).toBe(false);
    expect(isRetiredCache("workbox-precache")).toBe(false);
    expect(isRetiredCache("")).toBe(false);
  });

  it("is false for a non-string key", () => {
    expect(isRetiredCache(null)).toBe(false);
    expect(isRetiredCache(undefined)).toBe(false);
  });

  it("names the prefix it retires", () => {
    expect(RETIRED_CACHE_PREFIX).toBe("zamimg-");
  });
});

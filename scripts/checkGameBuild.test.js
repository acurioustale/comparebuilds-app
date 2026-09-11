import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "node:module";
import {
  parseArgs,
  compareBuild,
  writeStamp,
  readStamp,
  STAMP_PATH,
} from "./checkGameBuild.js";
import { splitBuild } from "./lib/raidbots.js";

const require = createRequire(import.meta.url);
const tmpStamp = () =>
  join(mkdtempSync(join(tmpdir(), "cb-stamp-")), "gameBuild.json");

describe("splitBuild", () => {
  it("splits a build string into patch version and build number", () => {
    expect(splitBuild("12.1.0.69587")).toEqual({
      version: "12.1.0",
      build: "69587",
    });
  });

  it("returns a null build number for an unexpected shape", () => {
    // Never throw on a malformed upstream value: the caller compares strings, so
    // a degraded-but-defined result keeps the probe reporting instead of dying.
    expect(splitBuild("12.1.0")).toEqual({ version: "12.1.0", build: null });
    expect(splitBuild(undefined)).toEqual({ version: "", build: null });
  });
});

describe("compareBuild", () => {
  const stamp = { acknowledgedBuild: "12.1.0.69587" };

  it("ignores a build-number-only bump by default", () => {
    // A hotfix build moves the last segment many times per patch without
    // touching talent trees. Alerting on those trains everyone to ignore the
    // check, so the default compares the patch version only.
    const r = compareBuild("12.1.0.70001", stamp);
    expect(r.changed).toBe(false);
    expect(r.scope).toBe("patch version");
  });

  it("reports a patch bump", () => {
    const r = compareBuild("12.1.5.70001", stamp);
    expect(r).toMatchObject({ changed: true, from: "12.1.0", to: "12.1.5" });
  });

  it("reports a build-number-only bump under --exact", () => {
    const r = compareBuild("12.1.0.70001", stamp, true);
    expect(r).toMatchObject({
      changed: true,
      from: "12.1.0.69587",
      to: "12.1.0.70001",
      scope: "build",
    });
  });

  it("treats a missing stamp value as changed rather than equal", () => {
    // An empty acknowledgement must not read as "already up to date" — that
    // would make an unstamped repo permanently green.
    expect(compareBuild("12.1.0.69587", {}).changed).toBe(true);
  });
});

describe("writeStamp", () => {
  it("records the build and date, creating the file if absent", () => {
    const path = tmpStamp();
    expect(existsSync(path)).toBe(false);
    const next = writeStamp("12.2.0.71000", {
      path,
      now: new Date("2026-10-01T12:00:00Z"),
    });
    expect(next).toMatchObject({
      acknowledgedBuild: "12.2.0.71000",
      acknowledgedAt: "2026-10-01",
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(next);
  });

  it("preserves keys it does not own", () => {
    // The committed stamp carries an explanatory _comment; rewriting the file
    // must not quietly delete it (or any field added later by hand).
    const path = tmpStamp();
    writeStamp("12.1.0.1", { path });
    const withComment = { ...readStamp(path), _comment: "why this exists" };
    require("fs").writeFileSync(path, JSON.stringify(withComment), "utf8");

    const next = writeStamp("12.2.0.2", { path });
    expect(next._comment).toBe("why this exists");
    expect(next.acknowledgedBuild).toBe("12.2.0.2");
  });
});

describe("checkGameBuild parseArgs", () => {
  it("defaults to a non-exact, read-only run", () => {
    expect(parseArgs([])).toEqual({ exact: false, accept: false });
  });

  it("rejects an unknown argument rather than ignoring it", () => {
    expect(() => parseArgs(["--acccept"])).toThrow(/unknown argument/);
  });
});

describe("the committed stamp", () => {
  it("parses and names a build the comparison can use", () => {
    const stamp = readStamp(STAMP_PATH);
    expect(splitBuild(stamp.acknowledgedBuild).build).not.toBeNull();
    expect(compareBuild(stamp.acknowledgedBuild, stamp).changed).toBe(false);
  });
});

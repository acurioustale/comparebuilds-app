/**
 * checkStaleOverrides.js
 * ----------------------
 * Answers one question about every entry in package.json's `overrides`: is it
 * still doing the job it was added for?
 *
 * Why this exists. An override is how you escape a transitive advisory when the
 * only alternative npm offers is a semver-major downgrade of the package that
 * pulls it in. That makes it a fix with no natural end: upstream eventually
 * repins or releases, the advisory stops applying, and the override stays —
 * silently holding a package back, long after the thing it was protecting
 * against is gone. This repo has already had that happen twice. The `js-yaml`
 * pin added for an advisory in <=4.1.1 ended up forcing a downgrade off a major
 * that upstream had moved to, and the `markdown-it` pin beside it had quietly
 * become a no-op.
 *
 * How it decides, and why not a semver comparison. The question is not "does
 * this override change the resolved version" — the stale js-yaml pin very much
 * did, which is exactly why it was holding a major back. The question is
 * whether the tree is still unsafe WITHOUT it. So for each override in turn,
 * this resolves a lockfile with that single entry removed and audits it. A
 * clean audit means upstream has caught up and the entry can go; a dirty one
 * names the advisory still keeping it alive.
 *
 * Reports only, and exits zero either way. A stale override is untidy, never
 * urgent, and this runs in the non-gating `audit` workflow.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const overrides = pkg.overrides ?? {};
const names = Object.keys(overrides);

if (names.length === 0) {
  console.log("No overrides declared. Nothing to check.");
  process.exit(0);
}

/**
 * Resolve a lockfile for `pkg` minus one override and audit it. Returns null
 * when that tree is clean, or npm's audit output when it is not.
 *
 * --package-lock-only keeps this to a resolution plus a registry query; nothing
 * is installed and node_modules is never written.
 */
function auditWithout(name) {
  const dir = mkdtempSync(join(tmpdir(), "stale-override-"));
  try {
    const trimmed = { ...pkg, overrides: { ...overrides } };
    delete trimmed.overrides[name];
    if (Object.keys(trimmed.overrides).length === 0) delete trimmed.overrides;
    writeFileSync(join(dir, "package.json"), JSON.stringify(trimmed, null, 2));

    execFileSync("npm", ["install", "--package-lock-only", "--silent"], {
      cwd: dir,
      stdio: "ignore",
    });
    execFileSync("npm", ["audit"], { cwd: dir, stdio: "pipe" });
    return null;
  } catch (err) {
    // A non-zero exit from `npm audit` means advisories, which is a result
    // rather than a failure. Anything else (a resolution error, npm missing)
    // is reported as-is so a broken check can't read as a clean one.
    if (err.stdout) return err.stdout.toString();
    throw err;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("── Override check ──\n");

const stale = [];
for (const name of names) {
  const advisories = auditWithout(name);
  if (advisories === null) {
    stale.push(name);
    console.log(`  ${name}: STALE — the tree is clean without it.`);
  } else {
    const summary = advisories
      .split("\n")
      .find((l) => /vulnerabilit/i.test(l))
      ?.trim();
    console.log(
      `  ${name}: still load-bearing — ${summary ?? "advisories remain"}`,
    );
  }
}

if (stale.length > 0) {
  console.log(
    `\nRemove ${stale.length === 1 ? "this override" : "these overrides"} from ` +
      `package.json and run npm install: ${stale.join(", ")}.`,
  );
} else {
  console.log("\nEvery override is still earning its place.");
}

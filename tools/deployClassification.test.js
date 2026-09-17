import { test } from "vitest";
import assert from "node:assert/strict";

import {
  classifyNonApi,
  ignoreMatcher,
  pathsIgnoreDrift,
  readPathsIgnore,
} from "./deploy-classification.mjs";

// deploy.yml's paths-ignore decides whether a push to main redeploys. These rules
// are what binds that list to reality, so the failure mode they exist to prevent
// is a file wrongly called dev-only: a real change merges and is never published,
// silently. Every assertion below is written from that direction — "is this
// really invisible to the build?" — not from "does the pattern parse".

// --- classifyNonApi: the deploy-affecting side ------------------------------

// dist/ is a build product, so none of these are uploaded; all of them change
// what IS uploaded. This is the half the sibling repo does not have to think
// about, and the half that is easy to get lethally wrong.
test("classifyNonApi treats everything the build reads as deploy-affecting", () => {
  for (const path of [
    "src/main.jsx",
    "src/lib/treeLogic.js",
    "src/data/mage.json",
    "src/index.css",
    "src/assets/fonts/FRIZQT__.ttf",
    "public/favicon.svg",
    "public/talent-icons/ability_mage_firestarter.jpg",
    "public/.well-known/security.txt",
    "index.html",
    "vite.config.js",
  ]) {
    assert.equal(classifyNonApi(path), "deploy-affecting", path);
  }
});

// Our runtime dependencies are bundled into dist/, unlike the sibling's vendored
// JS. A bump that merged and never deployed would leave the old bytes served.
test("classifyNonApi treats the dependency manifests as deploy-affecting", () => {
  assert.equal(classifyNonApi("package.json"), "deploy-affecting");
  assert.equal(classifyNonApi("package-lock.json"), "deploy-affecting");
});

// Two scripts/ entries run inside `npm run build`; the rest are operator tools.
test("classifyNonApi separates the build-time scripts from the operator ones", () => {
  assert.equal(classifyNonApi("scripts/prerenderSpecs.js"), "deploy-affecting");
  assert.equal(
    classifyNonApi("scripts/generateLayoutManifest.js"),
    "deploy-affecting",
  );
  for (const path of [
    "scripts/ingestBlizzard.js",
    "scripts/compareSources.js",
    "scripts/checkWireLayout.js",
    "scripts/checkGameBuild.js",
    "scripts/fetchIcons.js",
    "scripts/fetchTopBuilds.js",
    "scripts/gameBuild.json",
    "scripts/lib/blizzardApi.js",
  ]) {
    assert.equal(classifyNonApi(path), "dev-only", path);
  }
});

// deploy.sh IS the deploy: an API_ASSETS entry or an rsync flag changing there
// changes what reaches the host, so a commit touching only it must still run.
test("classifyNonApi treats deploy.sh as deploy-affecting but validate.sh as dev-only", () => {
  assert.equal(classifyNonApi("deploy.sh"), "deploy-affecting");
  assert.equal(classifyNonApi("validate.sh"), "dev-only");
});

// --- classifyNonApi: the dev-only side --------------------------------------

test("classifyNonApi marks the tooling directories dev-only", () => {
  for (const path of [
    ".claude/settings.json",
    ".github/workflows/deploy.yml",
    "e2e/theme.spec.js",
    "ops/rsync-jail-comparebuilds.sh",
    "tests/ShareValidationTest.php",
    "tools/check-csp.mjs",
    "tools/shared/html-tags.mjs",
    "src/test/setup.js",
    "src/test/buildStrings.js",
  ]) {
    assert.equal(classifyNonApi(path), "dev-only", path);
  }
});

test("classifyNonApi marks documentation and tool configs dev-only", () => {
  for (const path of [
    "README.md",
    "CLAUDE.md",
    "ops/README.md",
    ".github/pull_request_template.md",
    ".editorconfig",
    ".env.example",
    ".tool-versions",
    ".mise.toml",
    ".php-cs-fixer.dist.php",
    "eslint.config.js",
    "phpunit.xml",
    "playwright.config.js",
    "lychee.toml",
    "LICENSE",
  ]) {
    assert.equal(classifyNonApi(path), "dev-only", path);
  }
});

// Precedence: the test carve-out has to beat the broad src/ directory rule, or
// 57 src test files would demand a redeploy they cannot possibly affect. Safe
// only because nothing outside a test imports a test, and the bundle's single
// import.meta.glob covers ../data/*.json alone.
test("classifyNonApi lets the test carve-out win over the src/ directory rule", () => {
  assert.equal(classifyNonApi("src/lib/treeLogic.test.js"), "dev-only");
  assert.equal(
    classifyNonApi("src/components/TalentNode.test.jsx"),
    "dev-only",
  );
  assert.equal(classifyNonApi("scripts/ingestBlizzard.test.js"), "dev-only");
  // …and only for genuine test files, not a lookalike name.
  assert.equal(classifyNonApi("src/lib/testing.js"), "deploy-affecting");
  assert.equal(classifyNonApi("src/lib/protest.jsx"), "deploy-affecting");
});

// --- classifyNonApi: the forcing function -----------------------------------

// A new kind of file matching no rule is neither, so the guard fails and someone
// answers "does the build read this?" once, deliberately. Without this a new
// dev-only file would default to deploy-affecting and never be noticed.
test("classifyNonApi leaves an unrecognised path unclassified", () => {
  assert.equal(classifyNonApi(".npmrc"), "unclassified");
  assert.equal(classifyNonApi("scripts/newOperatorScript.js"), "unclassified");
  assert.equal(classifyNonApi("docs/architecture.puml"), "unclassified");
});

// --- readPathsIgnore --------------------------------------------------------

const WORKFLOW = `name: deploy
on:
  push:
    branches: [main]
    # a comment above the key
    paths-ignore:
      # a comment inside the block
      - "**.md"
      - ".github/**"
      - LICENSE
  pull_request:
jobs:
  validate:
    steps:
      - uses: actions/checkout@v7
`;

test("readPathsIgnore reads the block, strips quotes and skips comments", () => {
  assert.deepEqual(readPathsIgnore(WORKFLOW), {
    ok: true,
    patterns: ["**.md", ".github/**", "LICENSE"],
  });
});

test("readPathsIgnore stops at the next YAML key", () => {
  const { patterns } = readPathsIgnore(WORKFLOW);
  assert.ok(!patterns.some((p) => p.includes("actions/checkout")));
});

// Reading one of two blocks would verify part of the list and report success —
// exactly the fail-open direction this guard must never take.
test("readPathsIgnore refuses to read a partial list", () => {
  assert.deepEqual(readPathsIgnore("on:\n  push:\n    branches: [main]\n"), {
    ok: false,
    count: 0,
  });
  assert.deepEqual(
    readPathsIgnore(
      `on:\n  push:\n    paths-ignore:\n      - "a"\n  pull_request:\n    paths-ignore:\n      - "b"\n`,
    ),
    { ok: false, count: 2 },
  );
});

// --- ignoreMatcher ----------------------------------------------------------

test("ignoreMatcher translates a directory glob to a prefix", () => {
  const match = ignoreMatcher("tools/**");
  assert.equal(match("tools/check-csp.mjs"), true);
  assert.equal(match("tools/shared/html-tags.mjs"), true);
  // Must not catch a sibling path that merely starts with the same characters.
  assert.equal(match("toolsmith.js"), false);
  assert.equal(match("src/tools/x.js"), false);
});

test("ignoreMatcher translates a suffix glob", () => {
  const match = ignoreMatcher("**.test.js");
  assert.equal(match("src/lib/diff.test.js"), true);
  assert.equal(match("tools/shared/htmlTags.test.js"), true);
  assert.equal(match("src/lib/diff.test.jsx"), false);
  assert.equal(match("src/lib/diff.js"), false);
});

test("ignoreMatcher translates a plain path to an exact match", () => {
  const match = ignoreMatcher("LICENSE");
  assert.equal(match("LICENSE"), true);
  assert.equal(match("LICENSE.md"), false);
});

// An unfamiliar shape must come back as null so the guard fails loudly. Guessing
// would compare the workflow against a set it does not actually ignore.
test("ignoreMatcher refuses a glob shape it cannot translate faithfully", () => {
  for (const pattern of ["src/**/*.css", "public/*", "api/?.php", "**/*.md"]) {
    assert.equal(ignoreMatcher(pattern), null, pattern);
  }
});

// --- pathsIgnoreDrift -------------------------------------------------------

test("pathsIgnoreDrift is silent when the two lists agree", () => {
  const tracked = ["README.md", "src/main.jsx", "tools/check-csp.mjs"];
  const devOnly = (p) => p !== "src/main.jsx";
  const ignored = (p) => p !== "src/main.jsx";
  assert.deepEqual(pathsIgnoreDrift(tracked, ignored, devOnly), []);
});

// The dangerous direction: a deploy-affecting file listed in paths-ignore. That
// push merges and never deploys.
test("pathsIgnoreDrift reports a deploy-affecting file that is ignored", () => {
  const drift = pathsIgnoreDrift(
    ["package-lock.json"],
    () => true,
    () => false,
  );
  assert.deepEqual(drift, [{ path: "package-lock.json", devOnly: false }]);
});

// The merely wasteful direction: a dev-only file nobody added to the list.
test("pathsIgnoreDrift reports a dev-only file that is not ignored", () => {
  const drift = pathsIgnoreDrift(
    ["tools/new-guard.mjs"],
    () => false,
    () => true,
  );
  assert.deepEqual(drift, [{ path: "tools/new-guard.mjs", devOnly: true }]);
});

// --- the real workflow ------------------------------------------------------

// The guard binds these against git's tracked set at gate time; this pins the
// shapes that reading depends on, so a reformat of the block fails here with a
// clear cause rather than inside the guard.
test("the real deploy.yml paths-ignore parses into translatable patterns", async () => {
  const { readFile } = await import("node:fs/promises");
  const yaml = await readFile(
    new URL("../.github/workflows/deploy.yml", import.meta.url),
    "utf8",
  );
  const block = readPathsIgnore(yaml);
  assert.equal(block.ok, true);
  assert.ok(block.patterns.length > 0);
  for (const pattern of block.patterns) {
    assert.notEqual(ignoreMatcher(pattern), null, pattern);
  }
});

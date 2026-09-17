// Which tracked files can change what this site puts on the server — and the
// reading of deploy.yml's `paths-ignore` that has to agree with it.
//
// Consumed by tools/check-deploy-assets.mjs, which binds the two so neither can
// drift. Kept here, with tests of its own, rather than as regexes and literals
// inside the guard: a guard rule that is subtly wrong on real input fails in the
// fail-open direction, so anything a guard needs to READ becomes a tested helper.
//
// Not in tools/shared/: the sibling repo has the same binding but a different
// classification — it ships tracked files directly, so its whole build/test
// toolchain is dev-only. Ours is harder (see below), so a byte-identical copy
// could not serve both.
//
// ─── The distinction this file draws ──────────────────────────────────────────
//
// NOT "is this file uploaded to the server" — `deploy.sh` uploads dist/ plus the
// API_ASSETS list, and dist/ is not tracked at all. The question is the useful
// one for skipping a redeploy: **can changing this file change what the deploy
// puts on the server?** For the API half those coincide (the PHP is shipped
// verbatim). For the static half they do not: src/, index.html, public/ and the
// Vite config are never themselves uploaded, yet every one of them feeds
// `vite build`, so a change to any of them changes dist/ and MUST redeploy.
//
// Getting that backwards is the worst failure this guard has: a deploy-affecting
// file wrongly called dev-only lands in paths-ignore, and a real change then
// merges to main and is silently never published. So the rule when a new kind of
// file appears is: deploy-affecting unless you can say precisely why nothing the
// build reads can see it.
//
// ─── Precedence ───────────────────────────────────────────────────────────────
//
// Dev-only is tested FIRST and wins. The dev-only rules are carve-outs out of the
// broad deploy-affecting directories: `src/**` feeds the bundle, but
// `src/lib/foo.test.js` and `src/test/` cannot reach it — nothing outside a test
// imports a test, and the only `import.meta.glob` in the bundle
// (src/store/storeHelpers.js) globs `../data/*.json`, so no glob can sweep one in.

/** Directories whose every file is dev-only. Prefix match, trailing slash. */
export const DEV_ONLY_DIRS = [
  ".claude/", // agent instructions
  ".github/", // workflows, issue templates — orchestration, never content
  "e2e/", // Playwright specs (non-gating, never bundled)
  "ops/", // the server-side rsync jail, installed to the host BY HAND
  "scripts/lib/", // ingest/compare/fetch internals; nothing here runs in `npm run build`
  "src/test/", // vitest setup and shared fixtures
  "tests/", // PHPUnit suite for the api/ helpers
  "tools/", // the guards themselves, plus the mirrored shared/ bundle
];

/**
 * Filename suffixes that make a file dev-only wherever it lives. `.test.js` /
 * `.test.jsx` are safe as a blanket rule precisely because a test is unreachable
 * from an entry point — see Precedence above.
 */
export const DEV_ONLY_SUFFIXES = [".md", ".test.js", ".test.jsx"];

/** Individually classified dev-only files. */
export const DEV_ONLY_FILES = new Set([
  // Tool and lint configuration. None of it is read by `vite build`.
  ".editorconfig",
  ".env.example", // template for the ingest credentials; build-time only, and not even that
  ".git-blame-ignore-revs",
  ".gitignore",
  ".markdownlint-cli2.jsonc",
  ".mise.toml",
  ".php-cs-fixer.dist.php",
  ".prettierignore",
  ".stylelintrc.json",
  ".tool-versions", // pins the gate's toolchain, not the bundle's contents
  "LICENSE",
  "eslint.config.js",
  "lychee.toml",
  "phpunit.xml",
  "playwright.config.js",
  "validate.sh", // mirrors the gate locally; publishes nothing
  // scripts/ is NOT a dev-only directory: two of its scripts run during the
  // build (see DEPLOY_AFFECTING_FILES). The rest are operator tools — ingest,
  // drift checks, data refreshes — run by hand or by the non-gating sources.yml,
  // and their output is committed into src/data/, which is itself
  // deploy-affecting. So editing one of these changes nothing until the data it
  // writes is committed, and that commit redeploys.
  "scripts/checkGameBuild.js",
  "scripts/checkWireLayout.js",
  "scripts/compareSources.js",
  "scripts/fetchIcons.js",
  "scripts/fetchTopBuilds.js",
  "scripts/gameBuild.json", // the human acknowledgement stamp; read by checkGameBuild.js only
  "scripts/ingestBlizzard.js",
]);

/** Directories whose every file feeds the build. Prefix match, trailing slash. */
export const DEPLOY_AFFECTING_DIRS = [
  "public/", // copied verbatim into dist/ by Vite
  "src/", // the bundle, the class data, the fonts, the stylesheets
];

/** Individually classified deploy-affecting files. */
export const DEPLOY_AFFECTING_FILES = new Set([
  "index.html", // the Vite entry, and the template every prerendered spec page is cut from
  "vite.config.js", // build config, and cspMetaPlugin writes the <meta> CSP into dist/index.html
  // Both run in `npm run build` after `vite build`: prerenderSpecs.js writes the
  // 40 spec landing pages, sitemap.xml and robots.txt into dist/;
  // generateLayoutManifest.js writes api/current_layouts.json, which IS shipped
  // and which supersession-gated pruning reads.
  "scripts/prerenderSpecs.js",
  "scripts/generateLayoutManifest.js",
  // We differ from the sibling here, and it matters. They vendor their JS, so a
  // dependency bump changes nothing they serve. We BUNDLE ours — react, react-dom,
  // zustand and @floating-ui/react are compiled into dist/ — so a bump to either
  // file changes the bytes the browser downloads. Calling these dev-only would
  // leave a merged security patch unpublished until some unrelated change came
  // along to carry it.
  "package.json",
  "package-lock.json",
  // The deploy itself. A change here IS a change to what reaches the server —
  // an API_ASSETS entry added or removed, an rsync flag, the post-deploy
  // migration — and a commit touching only this file must therefore apply it.
  // (The sibling calls deploy.sh dev-only; .github/** stays dev-only for us
  // because deploy.yml only orchestrates, carrying no content to the host, and
  // a change to it governs the NEXT run regardless of whether this one deploys.)
  "deploy.sh",
]);

const underAny = (path, dirs) => dirs.some((dir) => path.startsWith(dir));

/**
 * Classify a tracked repo-relative path OUTSIDE api/. The api/ half is
 * classified by the caller against deploy.sh's own API_ASSETS array, so that
 * there is one source of truth for what the API ships rather than a second copy
 * restated here.
 *
 * @param {string} path repo-relative, forward slashes, not under api/
 * @returns {"dev-only"|"deploy-affecting"|"unclassified"}
 */
export function classifyNonApi(path) {
  // Dev-only first: these are carve-outs out of the broad directories below.
  if (
    underAny(path, DEV_ONLY_DIRS) ||
    DEV_ONLY_SUFFIXES.some((suffix) => path.endsWith(suffix)) ||
    DEV_ONLY_FILES.has(path)
  ) {
    return "dev-only";
  }
  if (underAny(path, DEPLOY_AFFECTING_DIRS) || DEPLOY_AFFECTING_FILES.has(path))
    return "deploy-affecting";
  // Deliberately neither. A new kind of file has to be classified by hand, so
  // that "does the build read this?" is answered once, consciously, by whoever
  // added it — rather than defaulting to an answer that might be wrong.
  return "unclassified";
}

/**
 * Read the single `paths-ignore:` block out of a workflow file.
 *
 * Deliberately not a YAML parse: the guard must not grow a dependency, and the
 * block is a flat list of scalars. The items are every `- <glob>` line following
 * the key, quotes stripped, up to the first line that is not a list item (the
 * next YAML key); comment lines inside the block are skipped.
 *
 * More than one block, or none, is a hard failure rather than a partial read —
 * reading one of two would check a subset of the list and report success.
 *
 * @returns {{ok: true, patterns: string[]} | {ok: false, count: number}}
 */
export function readPathsIgnore(workflowYaml) {
  const lines = workflowYaml.split("\n");
  const blocks = lines.filter((line) => /^\s*paths-ignore:\s*$/.test(line));
  if (blocks.length !== 1) return { ok: false, count: blocks.length };

  const patterns = [];
  let inBlock = false;
  for (const line of lines) {
    if (/^\s*paths-ignore:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (/^\s*#/.test(line)) continue; // a comment inside the block
    const item = line.match(/^\s*-\s*(.+?)\s*$/);
    if (!item) break; // first non-item line ends the block
    patterns.push(item[1].replace(/^["']|["']$/g, ""));
  }
  return { ok: true, patterns };
}

/**
 * Translate one paths-ignore glob into a predicate over a repo-relative path,
 * for the three shapes this workflow uses — and only those. Each mirrors exactly
 * how the classification above matches, so the two readings cannot disagree:
 *
 *   "dir/**"  → prefix, like DEV_ONLY_DIRS
 *   "**.ext"  → suffix, like DEV_ONLY_SUFFIXES
 *   "path"    → exact, like DEV_ONLY_FILES
 *
 * Any other shape returns null. The caller fails on that rather than guessing:
 * a glob translated under the wrong meaning would silently compare the workflow
 * against a set it does not actually ignore.
 *
 * @returns {((path: string) => boolean) | null}
 */
export function ignoreMatcher(pattern) {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -"**".length); // keeps the trailing slash
    return (path) => path.startsWith(prefix);
  }
  if (pattern.startsWith("**.") && !/[*?[\]]/.test(pattern.slice(2))) {
    const suffix = pattern.slice("**".length); // ".md"
    return (path) => path.endsWith(suffix);
  }
  if (!/[*?[\]]/.test(pattern)) return (path) => path === pattern;
  return null;
}

/**
 * Every tracked file must be ignored by the workflow exactly when it is dev-only.
 * Returns the files where that fails, each labelled with which way round it went
 * — the two directions are not equally bad, and the guard says so.
 *
 * @param {string[]} tracked repo-relative tracked paths
 * @param {(path: string) => boolean} ignored does paths-ignore match this path
 * @param {(path: string) => boolean} devOnly is this path dev-only
 * @returns {{path: string, devOnly: boolean}[]}
 */
export function pathsIgnoreDrift(tracked, ignored, devOnly) {
  return tracked
    .filter((path) => ignored(path) !== devOnly(path))
    .map((path) => ({ path, devOnly: devOnly(path) }));
}

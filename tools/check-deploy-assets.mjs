// Bind deploy.sh's API_ASSETS array to the tracked api/ tree and to what the
// shipped PHP actually requires, so the three can't drift.
//
// The site's static half ships whole (dist/ is built, then mirrored), but the
// API half is picked by hand out of a working tree that also holds files the
// server must not serve. deploy.sh stages exactly API_ASSETS and mirrors the
// staging directory with `rsync --delete`, so a runtime dependency missing from
// that array is not merely unshipped — it is DELETED server-side on the next
// deploy, and every request reaching its require fatals (or, for the layout
// manifest, supersession-gated pruning silently stops working). Nothing in the
// gate could see that before this guard: the omission lives in a shell array no
// test read.
//
// Three checks, each a way that array goes wrong:
//   1. Completeness — every tracked file under api/ is either shipped (covered
//      by an API_ASSETS entry) or explicitly listed as not shipped here. A file
//      that is neither fails, so adding one means consciously deciding
//      ship-or-not rather than silently defaulting to "not shipped".
//   2. Existence — every API_ASSETS entry resolves to something real (a tracked
//      path, or a declared build-generated one), so a rename or typo fails here
//      instead of aborting the deploy's staging mid-flight.
//   3. Requires — every `__DIR__`-relative require reachable from a shipped PHP
//      file resolves either to another shipped path or to a location outside the
//      web root entirely (config.php lives one level above it, deliberately).
//      This is the check that catches the api/lib/RateLimiter.php class of
//      mistake at its source rather than by having remembered to list it.
//
// A fourth check binds a second list to the same question. deploy.yml skips the
// redeploy when a push to main touches only files that cannot change what the
// deploy publishes, via an `on.push.paths-ignore` denylist. That YAML list cannot
// be computed from the workflow, so it drifts — and it drifts dangerously: a
// dev-only file missing from it merely redeploys for nothing, but a
// deploy-affecting file wrongly listed there makes a real change merge to main
// and never reach the server, with nothing red to notice. So every tracked file
// is classified and the two must agree exactly. The classification itself lives
// in tools/deploy-classification.mjs (with tests), because it is the genuinely
// hard half here: dist/ is a BUILD PRODUCT, so src/, index.html, public/, the
// Vite config and the bundled dependencies are deploy-affecting despite never
// being uploaded themselves.
//
// Two things about HOW deploy.sh stages that list shape what these checks can
// mean. It reads the api/ half out of HEAD (`git archive`) rather than off disk,
// so that a hand-run deploy from a dirty checkout cannot publish uncommitted PHP:
//
//   - Entries are git PATHSPECS there, not `cp` arguments. A glob or pathspec
//     magic prefix would resolve against HEAD by rules the plain-path matching
//     below does not reproduce, so the guard would be checking a different set
//     than the deploy stages. Entries are required to be literal paths instead
//     (isLiteralPath), which is the one form where the two agree.
//   - The tracked set read here is the INDEX (`git ls-files`), while the deploy
//     resolves against HEAD. At any committed state those are the same set, and
//     the drifts this check exists to catch — a renamed or typo'd entry — are
//     absent from both. The gap is only the transient "added but not yet
//     committed", where failing would just be noise on work in progress; CI runs
//     on a commit, where there is no gap. Completeness wants the index anyway:
//     the point is to make someone classify a file when they add it.
//
// Entries the BUILD writes are the exception to all of it: they are gitignored,
// so they are absent from HEAD and deploy.sh stages them from disk — passing one
// to `git archive` would match nothing and abort the archive. That split is
// deploy.sh's API_GENERATED array, read here rather than restated, so the set the
// guard treats as legitimately-untracked is the set the deploy copies off disk.
//
// Dependency-free on purpose: it parses the arrays straight out of deploy.sh (the
// one source of truth the deploy itself reads) and lists tracked files via git,
// rather than keeping a second copy of the set here. The require scanning lives
// in tools/php-requires.mjs with a test of its own, and the array parsing in
// tools/shell-arrays.mjs with one of its own.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { phpRequires, resolveRequire } from "./php-requires.mjs";
import { readShellArray, isLiteralPath } from "./shell-arrays.mjs";
import {
  classifyNonApi,
  ignoreMatcher,
  pathsIgnoreDrift,
  readPathsIgnore,
} from "./deploy-classification.mjs";

const root = new URL("../", import.meta.url);
const rootDir = fileURLToPath(root);

const deploySh = await readFile(new URL("deploy.sh", root), "utf8");

// Both arrays come out of deploy.sh itself. readShellArray refuses any shape it
// cannot read WHOLE — a second assignment, a `+=` append, a multi-line literal —
// because a partially-read list would leave this guard reporting success while
// classifying fewer files than actually ship.
const readArray = (name) => {
  const result = readShellArray(deploySh, name);
  if (result.ok) return result.entries;
  const why = {
    missing: `check-deploy-assets: could not find a ${name}=( ... ) array in deploy.sh`,
    multiple:
      `check-deploy-assets: expected exactly one \`${name}=( ... )\` array in\n` +
      "  deploy.sh, but found a second assignment or a `+=` append this parser\n" +
      "  does not read. Extend tools/shell-arrays.mjs so it covers the whole set.",
    multiline:
      `check-deploy-assets: deploy.sh's ${name} array does not close on its own\n` +
      "  line. Keep it a single one-line literal - reading a multi-line one would\n" +
      "  risk classifying against a partial set. Or extend tools/shell-arrays.mjs.",
  };
  console.error(why[result.reason]);
  process.exit(1);
};

const entries = readArray("API_ASSETS");

// Paths the build writes rather than git tracking, so the existence check knows
// they are legitimately absent from `git ls-files` — and so does deploy.sh, which
// keeps them out of the `git archive` pathspecs and copies them off disk. Read
// from deploy.sh rather than restated here: a second copy could disagree, and the
// disagreement that matters (a generated path handed to `git archive`) aborts the
// deploy rather than failing the gate. An entry that is neither tracked nor listed
// there is a typo, and treating every missing path as "probably generated" would
// defeat the check.
const GENERATED = new Set(readArray("API_GENERATED"));

// Tracked files, straight from git. NUL-delimited (`-z`): without it git
// C-quotes any path with a space or non-ASCII byte, which would then match
// neither a ship rule nor a not-shipped rule and fail the build spuriously.
// `tracked` is the api/ half the three API_ASSETS checks below reason about;
// `trackedAll` is the whole repo, which the paths-ignore binding needs.
const gitFiles = (...pathspecs) =>
  execFileSync("git", ["ls-files", "-z", ...pathspecs], {
    cwd: rootDir,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);

const tracked = gitFiles("api");
const trackedAll = gitFiles();

// Tracked api/ files the server must NOT serve. An explicit list, so a new one
// trips the completeness check and forces the decision. config.php.example is
// the annotated template for the real config that lives above the web root;
// shipping it would publish the shape of the credentials file (.htaccess blocks
// `.example` as defence in depth, which is a second lock, not a reason to ship).
const NOT_SHIPPED = new Set(["api/config.php.example"]);

// A path ships when it equals an API_ASSETS entry or lives under one of the
// directory entries (a directory pathspec archives the whole subtree). Plain
// prefix matching is only equivalent to what git does because entries are
// required to be literal paths — checked first, below.
const isShipped = (path) =>
  entries.some((entry) => path === entry || path.startsWith(entry + "/"));

let failed = false;

// 0. Pathspec safety: deploy.sh hands these entries to `git archive` as
// pathspecs, while everything below treats them as literal path prefixes. Those
// two readings only coincide for a plain path, so anything with glob or pathspec
// magic is refused rather than checked under a meaning the deploy does not use.
const magicEntries = entries.filter((entry) => !isLiteralPath(entry));
if (magicEntries.length) {
  failed = true;
  console.error(
    "check-deploy-assets: API_ASSETS entries must be plain literal paths. These\n" +
      "  carry glob or pathspec magic, which `git archive` would resolve against\n" +
      "  HEAD by rules this guard's prefix matching does not reproduce - so the\n" +
      "  set checked here would stop being the set deployed:",
  );
  for (const entry of magicEntries) console.error(`  ${entry}`);
}

// A generated entry that is not also in API_ASSETS is staged by nothing; one that
// IS tracked is misclassified, and deploy.sh would then skip it when archiving
// HEAD and ship whatever uncommitted copy happens to be on disk instead — exactly
// the hole staging from HEAD closes.
const strayGenerated = [...GENERATED].filter(
  (entry) => !entries.includes(entry),
);
if (strayGenerated.length) {
  failed = true;
  console.error(
    "check-deploy-assets: API_GENERATED lists paths that are not in API_ASSETS,\n" +
      "  so nothing stages them:",
  );
  for (const entry of strayGenerated) console.error(`  ${entry}`);
}

// 2. Existence: every entry resolves to a tracked path, a tracked directory, or
// a declared generated file.
const missingEntries = entries.filter(
  (entry) =>
    !GENERATED.has(entry) &&
    !tracked.some((f) => f === entry || f.startsWith(entry + "/")),
);
if (missingEntries.length) {
  failed = true;
  console.error(
    "check-deploy-assets: API_ASSETS lists entries that are neither tracked nor\n" +
      "  declared build-generated (a rename or a typo would abort the deploy):",
  );
  for (const entry of missingEntries) console.error(`  ${entry}`);
}

const trackedGenerated = [...GENERATED].filter((entry) =>
  tracked.some((f) => f === entry || f.startsWith(entry + "/")),
);
if (trackedGenerated.length) {
  failed = true;
  console.error(
    "check-deploy-assets: API_GENERATED lists tracked paths. deploy.sh withholds\n" +
      "  those from `git archive` and copies them off disk, so a tracked one would\n" +
      "  ship from the working tree - uncommitted edits and all:",
  );
  for (const entry of trackedGenerated) console.error(`  ${entry}`);
}

// A generated entry still has to exist by the time the deploy runs; the gate
// builds before reaching the guards, so check the file is actually there.
const missingGenerated = entries.filter(
  (entry) => GENERATED.has(entry) && !existsSync(new URL(entry, root)),
);
if (missingGenerated.length) {
  failed = true;
  console.error(
    "check-deploy-assets: API_ASSETS lists build-generated files the build did\n" +
      "  not produce (run `npm run build` first, or fix the generator):",
  );
  for (const entry of missingGenerated) console.error(`  ${entry}`);
}

// A file marked both shipped and not-shipped means the not-shipped list is
// hiding a file the deploy actually serves — a classification bug worth failing.
const conflicting = tracked.filter((f) => isShipped(f) && NOT_SHIPPED.has(f));
if (conflicting.length) {
  failed = true;
  console.error(
    "check-deploy-assets: files are both shipped and marked not-shipped (fix the lists):",
  );
  for (const f of conflicting) console.error(`  ${f}`);
}

// 1. Completeness: no tracked api/ file may be left unclassified.
const unclassified = tracked.filter(
  (f) => !isShipped(f) && !NOT_SHIPPED.has(f),
);
if (unclassified.length) {
  failed = true;
  console.error(
    "check-deploy-assets: tracked api/ files are neither shipped nor marked\n" +
      "  not-shipped. Add each to API_ASSETS in deploy.sh (to ship it) or to\n" +
      "  NOT_SHIPPED in tools/check-deploy-assets.mjs (to withhold it):",
  );
  for (const f of unclassified) console.error(`  ${f}`);
}

// 3. Requires: follow what the shipped PHP pulls in at runtime. A require that
// resolves above the repo root is the config file deliberately kept outside the
// web root; anything else must itself be shipped.
const shippedPhp = tracked.filter((f) => isShipped(f) && f.endsWith(".php"));
for (const file of shippedPhp) {
  const php = await readFile(new URL(file, root), "utf8");
  const { targets, unresolved } = phpRequires(php);
  if (unresolved) {
    failed = true;
    console.error(
      `check-deploy-assets: ${file} has ${unresolved} require/include this guard\n` +
        "  cannot resolve to a literal path, so its dependency is unverified.\n" +
        "  Use a `__DIR__`-relative literal, or extend tools/php-requires.mjs.",
    );
  }
  const dir = file.slice(0, file.lastIndexOf("/"));
  for (const target of targets) {
    const resolved = resolveRequire(dir, target);
    // Outside the repo root: config.php one level above the web root. Nothing
    // in the deploy set can cover it, and nothing should.
    if (resolved.startsWith("../")) continue;
    if (!isShipped(resolved)) {
      failed = true;
      console.error(
        `check-deploy-assets: ${file} requires ${resolved}, which API_ASSETS does\n` +
          "  not stage — rsync --delete would remove it server-side and every\n" +
          "  request reaching that require would fatal. Add it to API_ASSETS.",
      );
    }
  }
}

// ── 4. Bind deploy.yml's paths-ignore to the same question ────────────────────
// Classify every tracked file as dev-only or deploy-affecting, then require the
// workflow to ignore it exactly when it is dev-only.
//
// The api/ half is classified against API_ASSETS rather than by a second list
// here: what the API ships is already stated in deploy.sh, and a file it does not
// ship (config.php.example) cannot change what the deploy publishes, so
// "not shipped" IS "dev-only" for that half. Everything else goes through
// classifyNonApi, where the build makes the answer less obvious.
const isApiPath = (path) => path === "api" || path.startsWith("api/");
const classify = (path) =>
  isApiPath(path)
    ? isShipped(path)
      ? "deploy-affecting"
      : "dev-only"
    : classifyNonApi(path);

const unclassifiedAll = trackedAll.filter(
  (f) => classify(f) === "unclassified",
);
if (unclassifiedAll.length) {
  failed = true;
  console.error(
    "check-deploy-assets: tracked files are classified neither dev-only nor\n" +
      "  deploy-affecting, so deploy.yml's paths-ignore cannot be checked against\n" +
      "  them. Decide for each whether `npm run build` (or the API deploy) can see\n" +
      "  it, then add it to the matching list in tools/deploy-classification.mjs.\n" +
      "  When in doubt it is deploy-affecting: a wrong dev-only answer silently\n" +
      "  stops publishing real changes.",
  );
  for (const f of unclassifiedAll) console.error(`  ${f}`);
}

const workflowPath = ".github/workflows/deploy.yml";
const workflow = await readFile(new URL(workflowPath, root), "utf8");
const ignoreBlock = readPathsIgnore(workflow);
if (!ignoreBlock.ok) {
  console.error(
    `check-deploy-assets: expected exactly one \`paths-ignore:\` block in\n` +
      `  ${workflowPath}, found ${ignoreBlock.count}. Extend\n` +
      "  tools/deploy-classification.mjs to read them all before trusting this\n" +
      "  check - reading one of several would verify only part of the list.",
  );
  process.exit(1);
}

const matchers = [];
for (const pattern of ignoreBlock.patterns) {
  const matcher = ignoreMatcher(pattern);
  if (!matcher) {
    console.error(
      `check-deploy-assets: unsupported paths-ignore pattern "${pattern}" in\n` +
        `  ${workflowPath} - extend ignoreMatcher in\n` +
        "  tools/deploy-classification.mjs to translate it. Guessing at its\n" +
        "  meaning would compare the workflow against a set it does not ignore.",
    );
    process.exit(1);
  }
  matchers.push(matcher);
}
const ignoredByWorkflow = (path) => matchers.some((m) => m(path));

// A pattern matching nothing tracked is dead weight at best and a typo at worst
// (`e2e/**` mistyped still passes the agreement check below, because the files it
// meant to cover are then reported as unignored - but say plainly which entry is
// inert, since that is the actual repair).
const inertPatterns = ignoreBlock.patterns.filter(
  (pattern) => !trackedAll.some(ignoreMatcher(pattern)),
);
if (inertPatterns.length) {
  failed = true;
  console.error(
    `check-deploy-assets: ${workflowPath} paths-ignore entries match no tracked\n` +
      "  file (a typo, or a leftover from a deleted path):",
  );
  for (const pattern of inertPatterns) console.error(`  ${pattern}`);
}

const drift = pathsIgnoreDrift(
  trackedAll,
  ignoredByWorkflow,
  (f) => classify(f) === "dev-only",
);
if (drift.length) {
  failed = true;
  console.error(
    `check-deploy-assets: ${workflowPath} paths-ignore has drifted from the\n` +
      "  dev-only classification. A deploy-affecting file listed there would SKIP\n" +
      "  a real deploy; a dev-only file missing there redeploys for nothing:",
  );
  for (const { path, devOnly } of drift) {
    console.error(
      devOnly
        ? `  ${path}: dev-only but NOT ignored - add it to paths-ignore`
        : `  ${path}: deploy-affecting but IGNORED - remove it from paths-ignore`,
    );
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log(
    `check-deploy-assets: API_ASSETS covers the tracked api/ tree ` +
      `(${tracked.length} files classified, ${shippedPhp.length} PHP files' requires resolved); ` +
      `deploy.yml paths-ignore matches the dev-only split (${trackedAll.length} tracked files classified)`,
  );
}

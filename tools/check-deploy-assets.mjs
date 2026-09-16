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
//      instead of aborting the deploy's `cp -a` mid-flight.
//   3. Requires — every `__DIR__`-relative require reachable from a shipped PHP
//      file resolves either to another shipped path or to a location outside the
//      web root entirely (config.php lives one level above it, deliberately).
//      This is the check that catches the api/lib/RateLimiter.php class of
//      mistake at its source rather than by having remembered to list it.
//
// Dependency-free on purpose: it parses the array straight out of deploy.sh (the
// one source of truth the deploy itself reads) and lists tracked files via git,
// rather than keeping a second copy of the set here. The require scanning lives
// in tools/php-requires.mjs with a test of its own.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { phpRequires, resolveRequire } from "./php-requires.mjs";

const root = new URL("../", import.meta.url);
const rootDir = fileURLToPath(root);

const deploySh = await readFile(new URL("deploy.sh", root), "utf8");

// This parser reads exactly one `API_ASSETS=( ... )` literal. If deploy.sh ever
// grows a second assignment or an append (`API_ASSETS+=( ... )`), the single
// match below would cover only part of the shipped set and the completeness
// check would then pass on a partial list — silently. Assert the single-array
// assumption up front so any such refactor is a loud failure that sends the
// maintainer here to extend the parser, rather than under-verifying.
const mutations = deploySh.match(/^\s*API_ASSETS\s*\+?=\(/gm) ?? [];
if (mutations.length > 1 || mutations.some((m) => m.includes("+="))) {
  console.error(
    "check-deploy-assets: expected exactly one `API_ASSETS=( ... )` array in\n" +
      "  deploy.sh, but found a second assignment or a `+=` append this parser\n" +
      "  does not read. Extend the parser so it covers the whole shipped set.",
  );
  process.exit(1);
}

// Pull the entries out of the `API_ASSETS=( ... )` array: whitespace-separated
// tokens (the array spans a single line in deploy.sh) with any inline comment
// stripped, so this reads the same list the deploy stages. Anchored to the start
// of a line, so an `# API_ASSETS=(…)` example in the comment above the real
// array is not grabbed as the list.
const arrayMatch = deploySh.match(/^\s*API_ASSETS=\(([^)]*)\)/m);
if (!arrayMatch) {
  console.error(
    "check-deploy-assets: could not find an API_ASSETS=( ... ) array in deploy.sh",
  );
  process.exit(1);
}
const entries = arrayMatch[1]
  .replace(/#.*$/gm, "")
  .split(/\s+/)
  .filter(Boolean);

// Tracked files under api/, straight from git. NUL-delimited (`-z`): without it
// git C-quotes any path with a space or non-ASCII byte, which would then match
// neither a ship rule nor a not-shipped rule and fail the build spuriously.
const tracked = execFileSync("git", ["ls-files", "-z", "api"], {
  cwd: rootDir,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

// Paths the build writes rather than git tracking, so the existence check knows
// they are legitimately absent from `git ls-files`. Kept explicit: an entry that
// is neither tracked nor listed here is a typo, and treating every missing path
// as "probably generated" would defeat the check.
const GENERATED = new Set(["api/current_layouts.json"]);

// Tracked api/ files the server must NOT serve. An explicit list, so a new one
// trips the completeness check and forces the decision. config.php.example is
// the annotated template for the real config that lives above the web root;
// shipping it would publish the shape of the credentials file (.htaccess blocks
// `.example` as defence in depth, which is a second lock, not a reason to ship).
const NOT_SHIPPED = new Set(["api/config.php.example"]);

// A path ships when it equals an API_ASSETS entry or lives under one of the
// directory entries (deploy.sh copies those whole with `cp -a`).
const isShipped = (path) =>
  entries.some((entry) => path === entry || path.startsWith(entry + "/"));

let failed = false;

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

if (failed) {
  process.exitCode = 1;
} else {
  console.log(
    `check-deploy-assets: API_ASSETS covers the tracked api/ tree ` +
      `(${tracked.length} files classified, ${shippedPhp.length} PHP files' requires resolved)`,
  );
}

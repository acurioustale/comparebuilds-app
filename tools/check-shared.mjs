// Guard the mirrored bundle in tools/shared/ against silent drift. Those files
// are duplicated byte-for-byte in the sibling repo acurioustale/acurioustale-de
// — the same HTML/CSP/.htaccess parsing rules, the same tests — because both
// repos validate the same kind of markup and config with the same guards, and
// neither wants a private copy of a regex that has already been got wrong once.
// The repo's most common gate failure is a guard regex that was subtly wrong on
// real input, so a fix landing in one repo and not the other is the exact shape
// of bug this bundle exists to prevent.
//
// There is no package and no sync mechanism, so the bundle needs two alarms.
// This is the local one: MANIFEST.sha256 pins the contents, and the guard fails
// if the set of files or any hash differs — so editing a shared file without
// consciously re-hashing (and so without being told to mirror the change) breaks
// the gate. The cross-repo half is .github/workflows/shared-sync.yml, which
// diffs the two bundles weekly; it is non-gating, because a sibling that has not
// yet mirrored a change must not block a release here.
//
// Run from validate.sh and deploy.yml. `--write` regenerates the manifest
// (npm run shared:hash), so the hashing lives here once rather than in a shell
// one-liner that could compute it differently from the check.
//
// Dependency-free on purpose: node:crypto over our own files, no integrity
// tooling to install or pin.
import { createHash } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";

const SHARED = new URL("shared/", import.meta.url);
const MANIFEST = "MANIFEST.sha256";
const write = process.argv.includes("--write");

// Every file in the bundle as a sorted list of paths relative to tools/shared/,
// walked recursively rather than read one level deep: a helper tucked into a
// subdirectory is still part of the mirrored bundle, and a flat listing would
// leave it unpinned — free to drift in exactly the way the manifest exists to
// prevent. The manifest itself is excluded, since it is the record, not content.
async function bundleFiles(dir = SHARED, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      files.push(
        ...(await bundleFiles(new URL(`${entry.name}/`, dir), `${rel}/`)),
      );
    } else if (rel !== MANIFEST) {
      files.push(rel);
    }
  }
  return files.sort();
}

const files = await bundleFiles();

// `<sha256>  <filename>` — two spaces, the sha256sum(1)/shasum(1) text format,
// so the manifest can be verified by hand with `shasum -a 256 -c MANIFEST.sha256`
// from inside tools/shared/ without this guard.
const hashes = new Map(
  await Promise.all(
    files.map(async (rel) => [
      rel,
      createHash("sha256")
        .update(await readFile(new URL(rel, SHARED)))
        .digest("hex"),
    ]),
  ),
);
const render = () =>
  files.map((rel) => `${hashes.get(rel)}  ${rel}\n`).join("");

if (write) {
  await writeFile(new URL(MANIFEST, SHARED), render());
  console.log(
    `check-shared: wrote tools/shared/${MANIFEST} (${files.length} files)`,
  );
  process.exit(0);
}

// A missing manifest is the same failure as a wrong one — the bundle is
// unpinned — but it needs its own message, because the fix is to generate it
// rather than to reconcile a difference.
let manifest;
try {
  manifest = await readFile(new URL(MANIFEST, SHARED), "utf8");
} catch {
  console.error(
    `check-shared: tools/shared/${MANIFEST} is missing, so the mirrored bundle\n` +
      "  is unpinned. Generate it with `npm run shared:hash`.",
  );
  process.exit(1);
}

// Parse the recorded hashes. A line this format doesn't read is a corrupt
// manifest, not an absent entry: reporting it as "file missing from the
// manifest" would send the maintainer to re-hash a manifest whose real problem
// is a mangled line, so say which line failed to parse instead.
const recorded = new Map();
const malformed = [];
manifest.split("\n").forEach((line, i) => {
  if (!line.trim()) return;
  const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
  if (m) recorded.set(m[2], m[1]);
  else malformed.push(`  line ${i + 1}: ${line}`);
});

const problems = [];
if (malformed.length) {
  problems.push(
    `tools/shared/${MANIFEST} has unreadable lines (expected "<sha256>  <filename>"):`,
    ...malformed,
  );
}
for (const rel of files) {
  const want = recorded.get(rel);
  if (want === undefined)
    problems.push(`  ${rel}: in the bundle, not in the manifest`);
  else if (want !== hashes.get(rel))
    problems.push(
      `  ${rel}: hash differs — manifest ${want.slice(0, 12)}…, file ${hashes.get(rel).slice(0, 12)}…`,
    );
}
for (const rel of recorded.keys()) {
  if (!hashes.has(rel))
    problems.push(`  ${rel}: in the manifest, not in the bundle`);
}

if (problems.length) {
  console.error(
    "check-shared: the mirrored bundle in tools/shared/ has drifted\n",
  );
  for (const line of problems) console.error(line);
  console.error(
    "\n  This bundle is mirrored byte-for-byte in acurioustale/acurioustale-de.\n" +
      "  If the change is intended: regenerate the manifest with\n" +
      "  `npm run shared:hash`, and apply the same change there. A fix to a\n" +
      "  shared parser has to land in BOTH repos — that is what the bundle is for.",
  );
  process.exitCode = 1;
} else {
  console.log(
    `check-shared: tools/shared/ matches ${MANIFEST} (${files.length} files)`,
  );
}

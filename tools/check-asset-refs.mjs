// Guard that every local asset the shipped markup, stylesheets and manifest
// reference actually exists. Before this, only public/og-image.png was bound to
// the markup (tools/check-og-image.mjs opens it to read its IHDR); every other
// referenced file — the favicons, the apple-touch icon, humans.txt, the manifest
// itself, the manifest's icons, the hashed bundle/stylesheet/font Vite emits —
// had no existence check at all. Renaming public/icon-192.png without updating
// the manifest passed the whole gate (the renamed file still ships, and the
// deploy-set guard only looks at api/) yet 404s in the browser and on install.
//
// What counts as a reference lives in tools/shared/asset-refs.mjs (with its own
// test), not in a private regex here: <link>/<script>/<img>/<source>/<video>/
// <audio> URL attributes including srcset lists, the share-image metas
// (og:image, twitter:image — absolute, same-origin URLs, which an
// attribute-only scan missed entirely), url() targets in each linked stylesheet,
// and the manifest's icons and screenshots. Run from validate.sh and deploy.yml.
//
// WHICH TREE: the BUILT dist/, not the source tree, for the same reason
// tools/check-csp.mjs reads dist/ — the source tree is not what ships, and here
// the gap is not theoretical. Vite rewrites and invents references, so a
// source-side scan would check URLs that never reach a browser while missing
// every URL that does. Measured on this repo's own build:
//   * index.html's font preload href="/src/assets/fonts/FRIZQT__.ttf" ships as
//     "/assets/FRIZQT__-<hash>.ttf" — a source scan would assert the tracked
//     source file exists (it does) and never notice whether the hashed emit does;
//   * <script src="/src/main.jsx"> ships as "/assets/index-<hash>.js";
//   * the stylesheet <link> is INJECTED at build and appears in no source file,
//     so its url(/assets/FRIZQT__-<hash>.ttf) is unreachable from source;
//   * the 40 prerendered spec pages (scripts/prerenderSpecs.js) exist only in
//     dist/, and they are the pages most likely to drift from the entry page.
// What Vite does NOT rewrite is public/ references — /favicon.svg,
// /manifest.webmanifest, /og-image.png and the manifest's icon list pass through
// verbatim — and that is precisely the unchecked class this guard exists for.
// Reading dist/ covers both halves with one rule. The cost is that it must run
// after `npm run build`, as check-csp and check-deploy-assets already do.
//
// WHAT "EXISTS" MEANS, given two trees. dist/ is copied off disk by deploy.sh,
// so a file present there ships — presence is the bar for anything the build
// generated (hashed assets, prerendered pages). But a dist/ file that is a
// verbatim copy of a public/ file only exists here because that source file
// does, and CI builds from a clean checkout: an untracked public/ asset would
// build and pass locally, then simply not be in dist/ on the deploy runner. So
// for any reference that resolves to a public/ path, tracked-in-git is the bar
// too — the same standard tools/check-deploy-assets.mjs applies to api/, and for
// the same reason. Mapping a reference to `public/<path>` is exact, not a guess:
// public/ IS Vite's publicDir, copied into dist/ at the web root unchanged.
//
// Dependency-free on purpose: the shared scanners plus JSON.parse over our own
// manifest, and git ls-files for the tracked set.
import { readFile, readdir, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findTags } from "./shared/html-tags.mjs";
import {
  cssRefs,
  declaredOrigins,
  htmlRefs,
  localPath,
  manifestRefs,
} from "./shared/asset-refs.mjs";

const root = new URL("../", import.meta.url);
const dist = new URL("dist/", root);
const publicDir = new URL("public/", root);

// Every HTML page in dist/: the entry page plus the prerendered spec pages. All
// of them are scanned, not just the entry — they carry their own <head> copy, so
// a reference can drift in the prerenderer alone.
let pages;
try {
  pages = (await readdir(fileURLToPath(dist), { recursive: true }))
    .map((p) => p.split(sep).join("/"))
    .filter((p) => p.endsWith(".html"))
    .sort();
} catch {
  console.error(
    "check-asset-refs: dist/ not found - run `npm run build` first.",
  );
  process.exit(1);
}
if (!pages.includes("index.html")) {
  console.error(
    "check-asset-refs: dist/index.html not found - run `npm run build` first.",
  );
  process.exit(1);
}

const documents = new Map();
for (const page of pages)
  documents.set(page, await readFile(new URL(page, dist), "utf8"));

// The origins that are "us", unioned over every page: each page declares the
// site origin in its own canonical/og:url, and a same-origin absolute reference
// (the share-image metas) is only recognised as local against that set.
const origins = new Set();
for (const html of documents.values())
  for (const origin of declaredOrigins(html)) origins.add(origin);

const refs = [];
for (const [page, html] of documents)
  refs.push(...htmlRefs(html, origins, page));

// The manifest and the stylesheets are reached THROUGH the markup rather than by
// hardcoded path, so a renamed one is already reported above as a missing
// reference and its contents are scanned wherever the markup actually points.
// Deduplicated: 41 pages link the same two files, and scanning either 41 times
// would repeat every finding 41 times.
const seen = new Set();
for (const [page, html] of documents) {
  for (const [rel, scan] of [
    ["manifest", manifestScan],
    ["stylesheet", cssScan],
  ]) {
    for (const link of findTags(html, "link", { rel })) {
      const path = localPath(link.attrs.get("href"), { origins });
      if (!path || seen.has(path)) continue;
      seen.add(path);
      let text;
      try {
        text = await readFile(new URL(path, dist), "utf8");
      } catch {
        continue; // Already reported as a missing reference from `page`.
      }
      refs.push(...scan(text, path, page));
    }
  }
}

function manifestScan(text, path) {
  return manifestRefs(text, origins, path);
}

function cssScan(text, path) {
  return cssRefs(text, path, origins);
}

// Tracked files, straight from git (NUL-delimited so a path with a space or
// non-ASCII byte is not C-quoted), matching how the rest of the gate decides
// what would reach a clean checkout.
const tracked = new Set(
  execFileSync("git", ["ls-files", "-z"], {
    cwd: fileURLToPath(root),
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean),
);

async function isFile(url) {
  try {
    return (await stat(url)).isFile();
  } catch {
    return false;
  }
}

let failed = false;
const fail = (message) => {
  failed = true;
  console.error(`check-asset-refs: ${message}`);
};

for (const { path, where } of refs) {
  if (!(await isFile(new URL(path, dist)))) {
    fail(`${where} → "${path}" is not in dist/ (missing, renamed, or a typo?)`);
    continue;
  }
  // A dist/ file that came from public/ is source-side: it must be tracked, or a
  // clean-checkout build would not produce it however present it is here.
  const source = `public/${path}`;
  if ((await isFile(new URL(path, publicDir))) && !tracked.has(source)) {
    fail(
      `${where} → "${path}" ships from ${source}, which is not tracked by git - a clean checkout would not build it`,
    );
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log(
    `check-asset-refs: all ${refs.length} referenced local assets exist across ${pages.length} built page(s)`,
  );
}

// ─── Generate the current-layouts manifest ────────────────────────────────────
//
// Runs as part of `npm run build`. Reads the committed wire-layout snapshot
// (src/lib/wireLayout.snapshot.json — one entry per class, each carrying the
// layout `hash` that shares are stamped with) and writes api/current_layouts.json:
// the set of layout fingerprints that are current as of this build.
//
// The server is otherwise blind to which layouts are live — it only stores the
// hash a share was created with. This manifest is the bridge: after deploy,
// api/cron/ensure_schema.php feeds it to reconcile_layout_history() so the prune
// job can tell a superseded layout from a current one and honour "delete only
// once a layout is superseded AND the link has gone unused for the window."
//
// It's a snapshot, not a log: overwritten every build, always one entry per
// class (~13), a few hundred bytes. The accumulating "when did each layout die"
// record lives in the comparebuilds_layout_history table, not here.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT = path.join(ROOT, "src/lib/wireLayout.snapshot.json");
const OUT = path.join(ROOT, "api/current_layouts.json");

/**
 * Extracts the class_key → layout-hash map from a wire-layout snapshot. Throws if
 * any entry lacks a hash or the snapshot is empty, so a broken snapshot fails the
 * build loudly rather than shipping an empty (mass-supersession) manifest.
 * @param {Record<string, { hash?: unknown }>} snapshot
 * @returns {Record<string, string>}
 */
export function deriveHashes(snapshot) {
  const hashes = {};
  for (const [classKey, entry] of Object.entries(snapshot)) {
    if (!entry || typeof entry.hash !== "string") {
      throw new Error(
        `wireLayout snapshot entry "${classKey}" is missing a hash`,
      );
    }
    hashes[classKey] = entry.hash;
  }
  if (Object.keys(hashes).length === 0) {
    throw new Error(
      "wireLayout snapshot yielded no layout hashes — refusing to write an empty manifest",
    );
  }
  return hashes;
}

// Only write the file when run as a script, not when imported by a test.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
  const hashes = deriveHashes(snapshot);
  const manifest = { generatedAt: new Date().toISOString(), hashes };
  fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `Wrote ${path.relative(ROOT, OUT)} with ${Object.keys(hashes).length} layout hashes.`,
  );
}

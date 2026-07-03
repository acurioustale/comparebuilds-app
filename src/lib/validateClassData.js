/**
 * src/lib/validateClassData.js
 *
 * Structural validator for the normalised class data in src/data/{slug}.json.
 *
 * The app reads ONLY this normalised schema — it never touches the upstream data
 * source. That makes the schema the contract between "however the data was
 * produced" (the ingest script, a hand edit, or a different source entirely) and
 * "what the UI and the build-string parser assume". This validator enforces that
 * contract so a bad edit or a source swap fails loudly here instead of crashing
 * at render time or — worse — silently misparsing build strings.
 *
 * Pure data-in / errors-out: no I/O, no throwing (unless you call the assert
 * helper). Safe to import in both Node (tests, ingest) and the browser.
 *
 * Usage:
 *   import { validateClassData, assertValidClassData } from './validateClassData.js'
 *   const errors = validateClassData(classData, classIndexEntry)  // string[]
 *   assertValidClassData(classData, classIndexEntry)              // throws on first failure
 */

const NODE_TYPES = new Set(["round", "square", "choice", "apex"]);
const TREE_TYPES = new Set(["class", "spec", "hero"]);

const isInt = (v) => Number.isInteger(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isStr = (v) => typeof v === "string" && v.length > 0;
const isBool = (v) => typeof v === "boolean";
const isArr = (v) => Array.isArray(v);
// Node/choice icons are interpolated into a same-origin URL path by iconUrl.js
// (`/talent-icons/${icon}.jpg`). Constrain them to the Blizzard slug charset so
// a stray "/" or ".." in a hand-edited row can't escape the icons directory.
const isIconName = (v) => isStr(v) && /^[a-z0-9_]+$/i.test(v);

/**
 * Validates a single normalised class-data object.
 *
 * @param {object} data            Parsed src/data/{slug}.json
 * @param {object} [indexEntry]    Matching entry from classes.json (optional —
 *                                 enables cross-checks of ids/slugs/spec set)
 * @returns {string[]}  Human-readable error messages (empty = valid)
 */
export function validateClassData(data, indexEntry = null) {
  const errors = [];
  const err = (msg) => errors.push(msg);

  if (data == null || typeof data !== "object") {
    return ["class data must be an object"];
  }

  // ── Top-level fields ────────────────────────────────────────────────────────
  if (!isInt(data.classId)) err("classId must be an integer");
  if (!isStr(data.classSlug)) err("classSlug must be a non-empty string");
  if (!isStr(data.className)) err("className must be a non-empty string");

  if (data.unusedNodeIds != null) {
    if (!isArr(data.unusedNodeIds)) {
      err("unusedNodeIds must be an array when present");
    } else if (!data.unusedNodeIds.every(isInt)) {
      err("unusedNodeIds must contain only integers");
    }
  }

  if (
    data.specs == null ||
    typeof data.specs !== "object" ||
    isArr(data.specs)
  ) {
    err("specs must be an object keyed by spec slug");
    return errors;
  }
  const specSlugs = Object.keys(data.specs);
  if (specSlugs.length === 0) err("specs must contain at least one spec");

  // ── Per-spec ────────────────────────────────────────────────────────────────
  for (const slug of specSlugs) {
    const spec = data.specs[slug];
    const at = (msg) => err(`spec "${slug}": ${msg}`);

    if (spec == null || typeof spec !== "object") {
      at("must be an object");
      continue;
    }

    if (!isInt(spec.specId)) at("specId must be an integer");
    if (spec.specSlug !== slug)
      at(`specSlug "${spec.specSlug}" does not match its key "${slug}"`);
    // spec.icon flows into iconUrl() as a URL path segment (BuildManager renders
    // it), so constrain it to the slug charset like node/choice icons — otherwise
    // a "/" or ".." in a hand-edited row escapes the icons directory.
    if (!isIconName(spec.icon)) at("icon must be an icon slug ([A-Za-z0-9_])");

    // pointBudget
    const pb = spec.pointBudget;
    if (pb == null || typeof pb !== "object") {
      at("pointBudget must be an object");
    } else {
      for (const k of ["class", "spec", "hero"]) {
        if (!isInt(pb[k]) || pb[k] < 0)
          at(`pointBudget.${k} must be a non-negative integer`);
      }
    }

    // checkpoints
    const cp = spec.checkpoints;
    if (cp == null || typeof cp !== "object") {
      at("checkpoints must be an object");
    } else {
      for (const k of ["class", "spec"]) {
        if (!isArr(cp[k])) {
          at(`checkpoints.${k} must be an array`);
        } else {
          cp[k].forEach((c, i) => {
            if (!isInt(c?.row) || !isInt(c?.points)) {
              at(`checkpoints.${k}[${i}] must have integer { row, points }`);
            }
          });
        }
      }
    }

    if (spec.heroGateNodeId != null && !isInt(spec.heroGateNodeId)) {
      at("heroGateNodeId must be an integer or null");
    }

    // heroSubtrees
    const hs = spec.heroSubtrees;
    const subtreeNames = new Set();
    // True once heroSubtrees is present as an object we could read the intended
    // subtree names from — even if one or both of those names then failed the
    // string check. The per-node membership check below keys off this rather than
    // subtreeNames.size, so a spec that declares heroSubtrees but whose names are
    // BOTH invalid still has its hero nodes' heroSubtree references validated
    // instead of silently passing (which masked a second real error). This also
    // makes the both-invalid case consistent with the one-invalid case, which
    // already reports mismatches because subtreeNames is then non-empty.
    let heroSubtreesDeclared = false;
    if (hs == null || typeof hs !== "object") {
      at("heroSubtrees must be an object");
    } else {
      heroSubtreesDeclared = true;
      for (const side of ["left", "right"]) {
        const sub = hs[side];
        if (sub == null || typeof sub !== "object") {
          at(`heroSubtrees.${side} must be an object`);
        } else {
          if (!isStr(sub.name))
            at(`heroSubtrees.${side}.name must be a non-empty string`);
          else subtreeNames.add(sub.name);
          // NB: heroSubtrees.*.icon holds the subtree's display name, not an icon
          // slug, and is never passed to iconUrl() — so it only needs to be a
          // non-empty string, unlike node/choice/spec icons which do reach iconUrl.
          if (!isStr(sub.icon))
            at(`heroSubtrees.${side}.icon must be a non-empty string`);
        }
      }
    }

    // nodes
    if (!isArr(spec.nodes) || spec.nodes.length === 0) {
      at("nodes must be a non-empty array");
      continue;
    }

    const seenIds = new Set();
    const nodeIds = new Set(spec.nodes.map((n) => n?.id).filter(isInt));
    const usedSubtreeNames = new Set();

    spec.nodes.forEach((n, i) => {
      const nAt = (msg) =>
        at(`node[${i}]${isInt(n?.id) ? ` (id ${n.id})` : ""}: ${msg}`);

      if (n == null || typeof n !== "object") {
        nAt("must be an object");
        return;
      }

      if (!isInt(n.id)) nAt("id must be an integer");
      else if (seenIds.has(n.id)) nAt("duplicate node id");
      else seenIds.add(n.id);

      if (!NODE_TYPES.has(n.type))
        nAt(`type "${n.type}" not in {${[...NODE_TYPES]}}`);
      if (!TREE_TYPES.has(n.treeType))
        nAt(`treeType "${n.treeType}" not in {${[...TREE_TYPES]}}`);
      if (!isNum(n.posX)) nAt("posX must be a finite number");
      if (!isNum(n.posY)) nAt("posY must be a finite number");
      if (!isArr(n.connections) || !n.connections.every(isInt))
        nAt("connections must be an integer array");
      if (!isInt(n.spentRequired) || n.spentRequired < 0)
        nAt("spentRequired must be a non-negative integer");
      if (!isBool(n.alreadyGranted)) nAt("alreadyGranted must be a boolean");
      if (!isInt(n.maxRanks) || n.maxRanks < 1)
        nAt("maxRanks must be a positive integer");

      // Dangling connections are tolerated by the renderer (it filters them), but
      // they almost always signal a stale/incomplete edit — surface as an error.
      if (isArr(n.connections)) {
        for (const cid of n.connections) {
          if (isInt(cid) && !nodeIds.has(cid))
            nAt(`connection ${cid} references a node not in this spec`);
        }
      }

      // Type-specific shape
      if (n.type === "choice") {
        // entryChosen is encoded in a fixed 2-bit wire field (0–3), so a choice
        // node can carry at most 4 options; more would silently mis-decode
        // share links (buildString clamps the index to the last option).
        if (!isArr(n.choices) || n.choices.length < 2 || n.choices.length > 4) {
          nAt("choice node must have a choices array of length 2–4");
        } else {
          n.choices.forEach((ch, ci) => {
            if (!isStr(ch?.name))
              nAt(`choices[${ci}].name must be a non-empty string`);
            if (!isIconName(ch?.icon))
              nAt(`choices[${ci}].icon must be an icon slug ([A-Za-z0-9_])`);
            if (!isInt(ch?.maxRanks) || ch.maxRanks < 1)
              nAt(`choices[${ci}].maxRanks must be a positive integer`);
          });
        }
      } else if (n.type === "apex") {
        if (n.treeType !== "spec") nAt('apex node must have treeType "spec"');
        if (!isStr(n.name)) nAt("apex node must have a name");
        if (!isArr(n.ranks) || n.ranks.length === 0) {
          nAt("apex node must have a non-empty ranks array");
        } else {
          // Each rank must invest at least one point. TalentNode advances a
          // cumulative threshold by `rank.maxRanks` to render per-rank progress,
          // so a zero-rank would collapse two ranks onto one threshold. The
          // sum-vs-maxRanks check below doesn't catch this on its own — ranks of
          // [0, N] still sum correctly — so guard each rank exactly like the
          // choice-option branch above.
          n.ranks.forEach((r, ri) => {
            if (!isInt(r?.maxRanks) || r.maxRanks < 1)
              nAt(`ranks[${ri}].maxRanks must be a positive integer`);
            // spellId is the rank's distinct spell. The cross-spec consistency
            // check (nodeSig below) fingerprints the apex chain by spellId, so a
            // missing one collapses the signature to "?" and lets a genuine
            // cross-spec divergence pass. Require it at the schema root.
            if (!isInt(r?.spellId) || r.spellId < 1)
              nAt(`ranks[${ri}].spellId must be a positive integer`);
          });
          const sum = n.ranks.reduce(
            (s, r) => s + (isInt(r?.maxRanks) ? r.maxRanks : 0),
            0,
          );
          // Compare even when maxRanks is non-integer (already flagged above): a
          // node can carry both a malformed maxRanks and a mismatched ranks total,
          // and gating this on isInt would report only the first and let the
          // second ship. A non-integer maxRanks never equals the integer sum, so
          // the mismatch is surfaced alongside the type error.
          if (sum !== n.maxRanks) {
            nAt(`maxRanks ${n.maxRanks} != sum of rank maxRanks ${sum}`);
          }
        }
        // The ingest can emit a null level when no grant covers a rank; the UI
        // would then render a blank unlock level. Require positive-integer
        // entries so a null — or a zero/negative that would render a nonsensical
        // "Level 0" / "Level -N" unlock label — is caught here rather than
        // shipping in src/data. Character unlock levels are always >= 1.
        if (!isArr(n.levels) || !n.levels.every((lvl) => isInt(lvl) && lvl > 0))
          nAt("apex node must have a levels array of positive integers");
        // TalentNode reads `levels[i]` by rank index to render each rank's
        // "Level N" unlock label, so a levels array misaligned with ranks would
        // silently drop (or ignore) trailing labels — keep them in lockstep.
        else if (
          isArr(n.ranks) &&
          n.ranks.length > 0 &&
          n.levels.length !== n.ranks.length
        )
          nAt(
            `apex node levels length ${n.levels.length} must match ranks length ${n.ranks.length}`,
          );
        // collectClassNodes reads `choices ?? null`, so a stray non-null choices
        // would re-encode this apex as a multi-bit choice node and shift the wire
        // layout — guard it exactly like the round/square branch below.
        if (n.choices != null) nAt("apex node must have choices = null");
      } else {
        // round / square
        if (!isStr(n.name)) nAt("must have a name");
        if (!isIconName(n.icon))
          nAt("icon must be an icon slug ([A-Za-z0-9_])");
        if (n.choices != null) nAt("non-choice node must have choices = null");
      }

      // Hero membership
      if (n.treeType === "hero") {
        if (!isStr(n.heroSubtree)) {
          nAt("hero node must have a heroSubtree name");
        } else {
          usedSubtreeNames.add(n.heroSubtree);
          if (heroSubtreesDeclared && !subtreeNames.has(n.heroSubtree)) {
            nAt(
              `heroSubtree "${n.heroSubtree}" does not match either heroSubtrees entry`,
            );
          }
        }
      }
    });

    // Every declared subtree should actually have nodes, and vice versa
    for (const name of subtreeNames) {
      if (!usedSubtreeNames.has(name))
        at(`heroSubtree "${name}" is declared but no node belongs to it`);
    }
  }

  // ── Serialisation-space disjointness ─────────────────────────────────────────
  // collectClassNodes dedups the class-wide id set first-wins, so two entries
  // sharing an id silently collapse into one — corrupting the build-string wire
  // layout (caught only by the separate snapshot test, not here). Enforce
  // disjointness as part of the contract for both ways a collision can arise.
  const realNodeIds = new Set();
  // Wire-relevant fingerprint of a node: the fields collectClassNodes reads to
  // size its bit fields and decode ranks/choices. A node id shared across specs
  // (hero- and class-tree nodes appear under every spec) MUST fingerprint
  // identically everywhere — see the cross-spec check below.
  const nodeSig = (n) => {
    const ranks = isInt(n?.maxRanks) ? n.maxRanks : "?";
    if (isArr(n?.choices))
      return `r${ranks}|c:${n.choices
        .map((ch) => `${ch?.name ?? "?"}#${ch?.maxRanks ?? "?"}`)
        .join(",")}`;
    // Apex nodes carry a per-rank spell/unlock-level chain that collectClassNodes
    // resolves first-wins, exactly like maxRanks/choices. A shared id whose chain
    // differs across specs would silently render the winning spec's spells and
    // levels for the losing spec, so fingerprint the chain too.
    if (isArr(n?.ranks))
      return (
        `r${ranks}|a:${n.ranks
          .map((rk) => `${rk?.spellId ?? "?"}#${rk?.maxRanks ?? "?"}`)
          .join(",")}` + `|l:${isArr(n?.levels) ? n.levels.join(",") : "-"}`
      );
    return `r${ranks}|c:-`;
  };
  const nodeSigById = new Map(); // id -> { slug, sig } from the first spec seen
  const gates = [];
  for (const slug of specSlugs) {
    const spec = data.specs[slug];
    if (spec && typeof spec === "object") {
      if (isArr(spec.nodes)) {
        for (const n of spec.nodes) {
          if (!isInt(n?.id)) continue;
          realNodeIds.add(n.id);
          // collectClassNodes dedups the class-wide node list first-wins, so if
          // the same id carries a different maxRanks or choice-option list in
          // another spec, every build string for the losing spec silently decodes
          // ranks/choices against the winning spec's shape. Node count and order
          // are unchanged, so the wire-layout snapshot can't catch it — enforce
          // shape consistency here as part of the contract.
          const sig = nodeSig(n);
          const prev = nodeSigById.get(n.id);
          if (prev == null) nodeSigById.set(n.id, { slug, sig });
          else if (prev.sig !== sig)
            err(
              `node id ${n.id} has an inconsistent shape across specs ` +
                `("${prev.slug}": ${prev.sig} vs "${slug}": ${sig}) — ` +
                `would corrupt the wire layout`,
            );
        }
      }
      if (isInt(spec.heroGateNodeId))
        gates.push({ slug, id: spec.heroGateNodeId });
    }
  }

  // A heroGateNodeId is not in any nodes array; collectClassNodes models it as a
  // synthetic 2-option choice node only when the id is otherwise unseen. If it
  // collides with a real spec node the gate's choice modelling is dropped (or the
  // real node's data is), shifting every later node's bit position — so every
  // existing share link for the class would misparse. Keep the gate ids disjoint
  // from the real node ids.
  for (const { slug, id } of gates) {
    if (realNodeIds.has(id))
      err(
        `spec "${slug}": heroGateNodeId ${id} also appears as a real node id (would corrupt the wire layout)`,
      );
  }

  // unusedNodeIds are placeholders with NO talent data; one that collides with a
  // real node or a hero gate would silently replace that entry's maxRanks/choices
  // and corrupt the wire layout the same way.
  if (isArr(data.unusedNodeIds)) {
    const realIds = new Set(realNodeIds);
    for (const { id } of gates) realIds.add(id);
    for (const id of data.unusedNodeIds) {
      if (isInt(id) && realIds.has(id))
        err(
          `unusedNodeIds entry ${id} also appears as a real node id (would corrupt the wire layout)`,
        );
    }
  }

  // ── Cross-check against the classes.json index entry ─────────────────────────
  if (indexEntry) {
    if (indexEntry.id !== data.classId) {
      err(`index id ${indexEntry.id} != classId ${data.classId}`);
    }
    if (indexEntry.name !== data.classSlug) {
      err(`index name "${indexEntry.name}" != classSlug "${data.classSlug}"`);
    }
    for (const s of indexEntry.specs ?? []) {
      const match = data.specs?.[s.name];
      if (!match) err(`index spec "${s.name}" has no entry in specs`);
      else if (match.specId !== s.id)
        err(`index spec "${s.name}" id ${s.id} != specId ${match.specId}`);
    }
    for (const slug of Object.keys(data.specs ?? {})) {
      if (!(indexEntry.specs ?? []).some((s) => s.name === slug)) {
        err(`spec "${slug}" exists in data but not in the index`);
      }
    }
  }

  return errors;
}

/**
 * Throws an Error listing every problem if `data` is invalid.
 * @param {object} data Parsed src/data/{slug}.json
 * @param {object} [indexEntry] Matching entry from classes.json
 * @returns {void}
 */
export function assertValidClassData(data, indexEntry = null) {
  const errors = validateClassData(data, indexEntry);
  if (errors.length > 0) {
    const slug = data?.classSlug ?? "unknown";
    throw new Error(
      `Invalid class data for "${slug}" (${errors.length} problem${errors.length > 1 ? "s" : ""}):\n` +
        errors.map((e) => `  - ${e}`).join("\n"),
    );
  }
}

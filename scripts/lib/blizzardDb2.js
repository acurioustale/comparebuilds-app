/**
 * scripts/lib/blizzardDb2.js
 * --------------------------
 * Reads the WoW client's trait (talent) data straight from the game's DB2 tables,
 * via wago.tools' per-build CSV export. Used only by the build-time ingest; never
 * imported by the browser app.
 *
 * Why this exists: the web Game Data API serialises ordinary talent nodes fully,
 * but FLATTENS the spec "apex" capstone — a single node that grants a sequence of
 * DISTINCT, level-gated spells — down to its first entry only (it reports 1 rank
 * where the node really has 4). The complete structure lives in the client DB2
 * tables, which is what scrapers like Wowhead/Icy Veins parse. This module pulls
 * exactly those tables so the apex can be sourced from the truest layer instead of
 * borrowed from another dataset. Everything else still comes from the web API.
 *
 * The joins, for a node id (the same id used in build strings):
 *   TraitNodeXTraitNodeEntry  node → its entries, ordered by _Index
 *   TraitNodeEntry            entry → MaxRanks, NodeEntryType, TraitDefinitionID
 *   TraitDefinition           definition → SpellID
 *   TraitCond / TraitNodeXTraitCond   the per-rank unlock levels (CondType 5)
 *   TraitNodeGroupXTraitNode + TraitNodeGroupXTraitCond + TraitCond
 *                             the points-spent gate (SpentAmountRequired)
 *
 * An entry's NodeEntryType is the discriminator: ordinary/choice entries are
 * type 2, the apex's sequential entries are type 13. The points gate is read
 * from the node's group conditions, NOT inferred from the visual row — a node can
 * sit visually below a divider yet unlock at a lower threshold (e.g. Discipline's
 * Divine Procession).
 *
 * Build-pinned and disk-cached (scripts/.cache/blizzard-db2/<build>/, gitignored).
 * Node-only (fs + global fetch). No external dependencies.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { pruneSiblingDirs } from "./blizzardApi.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_ROOT = join(__dirname, "..", ".cache", "blizzard-db2");

// NodeEntryType for the sequential apex-capstone entries (ordinary and choice
// entries are type 2). This is what tells an apex apart from everything else.
const APEX_ENTRY_TYPE = "13";
// TraitCond.CondType for a "you may spend up to N ranks at level L" gate.
const COND_TYPE_LEVEL_GRANT = "5";
// TraitCond.CondType for the points-spent section gate (the only one whose
// SpentAmountRequired is a real tree gate; types 1/2 are prereq flags and
// progressive auto-grants whose SpentAmountRequired is not a gate threshold).
const COND_TYPE_SPENT_GATE = "0";

// ---------------------------------------------------------------------------
// Minimal RFC 4180 CSV parser (handles quoted fields, embedded commas/newlines)
// ---------------------------------------------------------------------------

export function parseCsv(text) {
  // Strip a leading UTF-8 BOM (U+FEFF) so the first header name is "ID" and not
  // a BOM-prefixed key — otherwise every .ID lookup misses and the row Maps
  // collide under undefined, silently corrupting gates, apex chains and
  // descriptions.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift() ?? [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class BlizzardDb2 {
  /**
   * @param {object} opts
   * @param {string} opts.build   wago build, e.g. "12.0.7.67808"
   * @param {boolean} [opts.cache=true]
   */
  constructor({ build, cache = true }) {
    if (!build) throw new Error("BlizzardDb2 requires a build");
    this.build = build;
    this.useCache = cache;
    this.cacheDir = join(CACHE_ROOT, build);
    if (cache) {
      pruneSiblingDirs(CACHE_ROOT, build); // drop stale per-build caches
      mkdirSync(this.cacheDir, { recursive: true });
    }
    this._loaded = false;
  }

  async _table(name) {
    const file = join(this.cacheDir, `${name}.csv`);
    if (this.useCache && existsSync(file)) {
      return parseCsv(readFileSync(file, "utf8"));
    }
    const url = `https://wago.tools/db2/${name}/csv?build=${this.build}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    const text = await res.text();
    if (this.useCache) writeFileSync(file, text, "utf8");
    return parseCsv(text);
  }

  /** Fetch + index the trait tables. Idempotent. */
  async load() {
    if (this._loaded) return this;
    const [nx, entry, def, cond, ncond, gxn, gxc, subtree] = await Promise.all([
      this._table("TraitNodeXTraitNodeEntry"),
      this._table("TraitNodeEntry"),
      this._table("TraitDefinition"),
      this._table("TraitCond"),
      this._table("TraitNodeXTraitCond"),
      this._table("TraitNodeGroupXTraitNode"),
      this._table("TraitNodeGroupXTraitCond"),
      this._table("TraitSubTree"),
    ]);
    this.index({ nx, entry, def, cond, ncond, gxn, gxc, subtree });
    return this;
  }

  /**
   * Build the lookup indexes from already-parsed table rows. Separated from load()
   * so the join logic is unit-testable without the network. Each arg is an array
   * of row objects (as parseCsv returns).
   */
  index({ nx, entry, def, cond, ncond, gxn, gxc, subtree }) {
    this._entryById = new Map(entry.map((r) => [r.ID, r]));
    this._defById = new Map(def.map((r) => [r.ID, r]));
    this._condById = new Map(cond.map((r) => [r.ID, r]));
    this._subtreeById = new Map(subtree.map((r) => [r.ID, r]));

    this._entriesByNode = new Map();
    for (const r of nx) {
      const list = this._entriesByNode.get(r.TraitNodeID) ?? [];
      list.push({ entryId: r.TraitNodeEntryID, index: Number(r._Index) });
      this._entriesByNode.set(r.TraitNodeID, list);
    }
    for (const list of this._entriesByNode.values())
      list.sort((a, b) => a.index - b.index);

    this._condsByNode = new Map();
    for (const r of ncond) {
      const list = this._condsByNode.get(r.TraitNodeID) ?? [];
      list.push(r.TraitCondID);
      this._condsByNode.set(r.TraitNodeID, list);
    }

    // node → groups, group → conds (the points-gate path)
    this._groupsByNode = new Map();
    for (const r of gxn) {
      const list = this._groupsByNode.get(r.TraitNodeID) ?? [];
      list.push(r.TraitNodeGroupID);
      this._groupsByNode.set(r.TraitNodeID, list);
    }
    this._condsByGroup = new Map();
    for (const r of gxc) {
      const list = this._condsByGroup.get(r.TraitNodeGroupID) ?? [];
      list.push(r.TraitCondID);
      this._condsByGroup.set(r.TraitNodeGroupID, list);
    }

    this._loaded = true;
    return this;
  }

  /**
   * The points-spent gate for a node (its section's "spend N to unlock" threshold),
   * read from the conditions on the node's groups. 0 if ungated. This is the
   * authoritative gate — it does not always match the node's visual row.
   */
  spentRequired(nodeId) {
    let req = 0;
    for (const g of this._groupsByNode.get(String(nodeId)) ?? [])
      for (const condId of this._condsByGroup.get(g) ?? []) {
        const c = this._condById.get(condId);
        if (c?.CondType !== COND_TYPE_SPENT_GATE) continue;
        const amt = Number(c.SpentAmountRequired) || 0;
        if (amt > req) req = amt;
      }
    return req;
  }

  /** Ordered TraitNodeEntry rows for a node, or []. */
  _entries(nodeId) {
    return (this._entriesByNode.get(String(nodeId)) ?? [])
      .map((e) => this._entryById.get(e.entryId))
      .filter(Boolean);
  }

  /**
   * If `nodeId` is an apex capstone, return its full rank chain; otherwise null.
   * @returns {{ ranks: Array<{spellId:number, maxRanks:number}>, levels: number[] }|null}
   */
  apexChain(nodeId) {
    const entries = this._entries(nodeId);
    if (!entries.length) return null;
    if (!entries.every((e) => e.NodeEntryType === APEX_ENTRY_TYPE)) return null;

    const ranks = entries.map((e) => ({
      spellId: Number(this._defById.get(e.TraitDefinitionID)?.SpellID),
      maxRanks: Number(e.MaxRanks),
    }));
    return { ranks, levels: this._apexLevels(nodeId, ranks) };
  }

  /**
   * Per-rank unlock levels, aligned one-to-one with `ranks`. Each CondType-5
   * condition says "up to GrantedRanks ranks at RequiredLevel", so a rank at
   * cumulative position N unlocks at the lowest RequiredLevel among the
   * conditions that cover it (GrantedRanks >= N). Resolving by coverage rather
   * than exact cumulative match keeps `levels` the same length as `ranks` even
   * when an entry's maxRanks is > 1 or the grant thresholds aren't sequential
   * (an exact-match lookup would silently drop those ranks' levels).
   */
  _apexLevels(nodeId, ranks) {
    const grants = [];
    for (const id of this._condsByNode.get(String(nodeId)) ?? []) {
      const c = this._condById.get(id);
      if (c?.CondType === COND_TYPE_LEVEL_GRANT)
        grants.push({
          ranks: Number(c.GrantedRanks),
          level: Number(c.RequiredLevel),
        });
    }
    const levels = [];
    let cumulative = 0;
    for (const r of ranks) {
      cumulative += r.maxRanks;
      let level = null;
      for (const g of grants) {
        if (g.ranks >= cumulative && (level == null || g.level < level))
          level = g.level;
      }
      // Carry the previous rank's level if no grant covers this one, so the
      // array stays aligned to `ranks` rather than going short.
      levels.push(level ?? levels[levels.length - 1] ?? null);
    }
    return levels;
  }

  /** A hero subtree's { name, description } by id (= the API hero-tree id), or null. */
  subtree(subTreeId) {
    const r = this._subtreeById.get(String(subTreeId));
    return r
      ? { name: r.Name_lang, description: r.Description_lang ?? "" }
      : null;
  }
}

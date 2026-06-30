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
// TraitCond.CondType for a spec restriction. When such a condition carries a
// SpecSetID it binds the node to that set of specs — how a tree shared by two
// specs gives each its own variant of a co-located talent. A node with no such
// condition is unrestricted (applies to every spec of its class).
const COND_TYPE_SPEC = "1";

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
  return rows.map((r, rowIndex) => {
    // A ragged (short or long) row would otherwise map trailing fields to
    // undefined, which Number() turns into NaN downstream — silently corrupting
    // an apex spellId/maxRanks or a gate threshold. Fail loud at the source.
    if (r.length !== header.length)
      throw new Error(
        `parseCsv: data row ${rowIndex} has ${r.length} fields, expected ${header.length} (header: ${header.join(",")})`,
      );
    return Object.fromEntries(header.map((h, i) => [h, r[i]]));
  });
}

// ---------------------------------------------------------------------------
// Spec-conditional tooltip rendering
// ---------------------------------------------------------------------------
//
// A few talents have a Spell.Description_lang that branches on the player's
// spec (`$?cN[…]`) and/or splices in effect values (`$sK`, `$<spellId>sK`). The
// web Game Data API can't resolve those without a spec context, so it returns an
// empty description — leaving the talent blank. We render them here at ingest.

/**
 * Selects the spec branch of a `$?cN[a]?cM[b][else]` template: the `[…]` whose
 * `cN` matches this spec (N = ChrSpecialization OrderIndex + 1), else the
 * trailing default. A template that doesn't start with `$?c` is returned as-is.
 */
function selectSpecBranch(tpl, orderIndex) {
  if (!tpl.startsWith("$?c")) return tpl;
  const want = orderIndex + 1;
  const branches = [];
  let i = 2; // past "$?"
  while (i < tpl.length) {
    if (tpl[i] === "?") i++; // separator between conditional branches
    const m = /^c(\d+)\[/.exec(tpl.slice(i));
    if (!m) break;
    let j = i + m[0].length;
    let depth = 1;
    const start = j;
    while (j < tpl.length && depth > 0) {
      if (tpl[j] === "[") depth++;
      else if (tpl[j] === "]") depth--;
      if (depth > 0) j++;
    }
    branches.push({ n: Number(m[1]), text: tpl.slice(start, j) });
    i = j + 1; // past the closing "]"
  }
  let elseText = "";
  if (tpl[i] === "[") {
    let j = i + 1;
    let depth = 1;
    const start = j;
    while (j < tpl.length && depth > 0) {
      if (tpl[j] === "[") depth++;
      else if (tpl[j] === "]") depth--;
      if (depth > 0) j++;
    }
    elseText = tpl.slice(start, j);
  }
  return branches.find((b) => b.n === want)?.text ?? elseText;
}

/**
 * Renders a DB2 spell-description template for one spec. Handles two token
 * kinds: the `$?cN[…]` spec branch and `$sK` / `$<spellId>sK` effect-value
 * splices (the |K|th effect's base value, 1-based, of this spell or spell
 * `<spellId>`). Any other tooltip syntax leaves a `$` behind, and we return ""
 * rather than show a half-rendered tooltip. Pure: `effects` maps spellId → base
 * values indexed by EffectIndex.
 *
 * @param {{template:string, orderIndex:number, thisSpellId:number, effects:Map<number, number[]>}} arg
 * @returns {string}
 */
export function renderSpellDescription({
  template,
  orderIndex,
  thisSpellId,
  effects,
}) {
  if (!template) return "";
  const filled = selectSpecBranch(template, orderIndex).replace(
    /\$(\d*)s(\d+)/g,
    (m, sid, k) => {
      const v = effects.get(sid ? Number(sid) : thisSpellId)?.[Number(k) - 1];
      // Number.isFinite (not `v == null`) so a NaN effect value — e.g. a
      // missing/non-numeric EffectBasePointsF column — leaves the token
      // unresolved and falls through to the blank-on-survivor guard below,
      // rather than rendering the literal string "NaN".
      return Number.isFinite(v) ? String(Math.abs(v)).replace(/\.0+$/, "") : m;
    },
  );
  // Bail to blank if an unhandled token survived — never show partial text.
  return filled.includes("$") ? "" : filled;
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

  // A single-column-filtered slice of a table. Used for the few huge tables we
  // can't load whole (Spell, SpellEffect): we only need rows for a handful of
  // spell ids, so fetch them on demand via wago's `filter[col]=val` query and
  // cache each slice on disk.
  async _filtered(name, col, val) {
    const file = join(this.cacheDir, `${name}__${col}_${val}.csv`);
    if (this.useCache && existsSync(file)) {
      return parseCsv(readFileSync(file, "utf8"));
    }
    const url = `https://wago.tools/db2/${name}/csv?build=${this.build}&filter[${col}]=${val}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    const text = await res.text();
    if (this.useCache) writeFileSync(file, text, "utf8");
    return parseCsv(text);
  }

  /** Fetch + index the trait tables. Idempotent. */
  async load() {
    if (this._loaded) return this;
    const [
      nx,
      entry,
      def,
      cond,
      ncond,
      gxn,
      gxc,
      subtree,
      specSetMember,
      chrSpecialization,
    ] = await Promise.all([
      this._table("TraitNodeXTraitNodeEntry"),
      this._table("TraitNodeEntry"),
      this._table("TraitDefinition"),
      this._table("TraitCond"),
      this._table("TraitNodeXTraitCond"),
      this._table("TraitNodeGroupXTraitNode"),
      this._table("TraitNodeGroupXTraitCond"),
      this._table("TraitSubTree"),
      this._table("SpecSetMember"),
      this._table("ChrSpecialization"),
    ]);
    this.index({
      nx,
      entry,
      def,
      cond,
      ncond,
      gxn,
      gxc,
      subtree,
      specSetMember,
      chrSpecialization,
    });
    return this;
  }

  /**
   * Build the lookup indexes from already-parsed table rows. Separated from load()
   * so the join logic is unit-testable without the network. Each arg is an array
   * of row objects (as parseCsv returns).
   */
  index({
    nx,
    entry,
    def,
    cond,
    ncond,
    gxn,
    gxc,
    subtree,
    specSetMember,
    chrSpecialization,
  }) {
    this._entryById = new Map(entry.map((r) => [r.ID, r]));
    this._defById = new Map(def.map((r) => [r.ID, r]));
    this._condById = new Map(cond.map((r) => [r.ID, r]));
    this._subtreeById = new Map(subtree.map((r) => [r.ID, r]));
    // spec id → ChrSpecialization OrderIndex (drives the `$?cN` branch pick).
    this._specOrderIndex = new Map(
      (chrSpecialization ?? []).map((r) => [r.ID, Number(r.OrderIndex)]),
    );

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

    // node → Set of spec ids it is restricted to (empty = unrestricted). A spec
    // condition (CondType 1 + SpecSetID) can hang off the node directly or off
    // one of its groups; resolve both paths and expand each SpecSetID to its
    // member ChrSpecializationIDs. This is how a tree shared by two specs binds
    // each variant of a co-located talent to the spec that actually sees it.
    const specsBySet = new Map();
    for (const r of specSetMember ?? []) {
      const set = specsBySet.get(r.SpecSet) ?? new Set();
      set.add(r.ChrSpecializationID);
      specsBySet.set(r.SpecSet, set);
    }
    this._nodeSpecs = new Map();
    const addSpecCond = (nodeId, condId) => {
      const c = this._condById.get(condId);
      if (c?.CondType !== COND_TYPE_SPEC || !c.SpecSetID) return;
      const set = this._nodeSpecs.get(nodeId) ?? new Set();
      for (const s of specsBySet.get(c.SpecSetID) ?? []) set.add(s);
      this._nodeSpecs.set(nodeId, set);
    };
    for (const [nodeId, condIds] of this._condsByNode)
      for (const condId of condIds) addSpecCond(nodeId, condId);
    for (const [nodeId, groups] of this._groupsByNode)
      for (const g of groups)
        for (const condId of this._condsByGroup.get(g) ?? [])
          addSpecCond(nodeId, condId);

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

  /**
   * Whether a talent node applies to a given spec. Nodes in a tree shared by
   * several specs can be spec-bound by a CondType-1 spec-set condition — a
   * variant talent only one spec sees (e.g. monk Conduit's Yu'lon's Knowledge
   * for Mistweaver vs Xuen's Bond for Windwalker, both at the same grid cell).
   * A node with no such condition is unrestricted.
   * @param {number|string} nodeId
   * @param {number|string} specId  ChrSpecialization id
   */
  appliesToSpec(nodeId, specId) {
    const specs = this._nodeSpecs.get(String(nodeId));
    return !specs || specs.size === 0 || specs.has(String(specId));
  }

  /** A spell's raw Description_lang template (on-demand, cached), or "". */
  async _spellTemplate(spellId) {
    this._tplCache ??= new Map();
    if (!this._tplCache.has(spellId)) {
      const rows = await this._filtered("Spell", "ID", spellId);
      const row = rows.find((r) => r.ID === String(spellId));
      this._tplCache.set(spellId, row?.Description_lang ?? "");
    }
    return this._tplCache.get(spellId);
  }

  /** A spell's effect base values indexed by EffectIndex (on-demand, cached). */
  async _spellEffects(spellId) {
    this._fxCache ??= new Map();
    if (!this._fxCache.has(spellId)) {
      const rows = await this._filtered("SpellEffect", "SpellID", spellId);
      const arr = [];
      for (const r of rows)
        // wago's filter is a prefix match (SpellID 123904 also returns 1239040…),
        // so keep only the exact spell's rows or a sibling's effect overwrites
        // ours at the same EffectIndex.
        if (r.SpellID === String(spellId))
          arr[Number(r.EffectIndex)] = Number(r.EffectBasePointsF);
      this._fxCache.set(spellId, arr);
    }
    return this._fxCache.get(spellId);
  }

  /**
   * The rendered DB2 description for `spellId` as seen by `specId`, or "" when it
   * can't be resolved. This is the spec-conditional text the web API leaves
   * blank; we pull the template from Spell, splice effect values from
   * SpellEffect (including any cross-spell `$<id>sK` references in the chosen
   * branch), and render. Cross-spell effects and the per-spec branch are why the
   * API can't do this itself.
   * @param {number|string} spellId
   * @param {number|string} specId  ChrSpecialization id
   */
  async descriptionFor(spellId, specId) {
    const orderIndex = this._specOrderIndex.get(String(specId));
    if (orderIndex == null) return "";
    const template = await this._spellTemplate(spellId);
    if (!template) return "";

    // Only the chosen branch's effect references need fetching.
    const branch = selectSpecBranch(template, orderIndex);
    const ids = new Set([Number(spellId)]);
    for (const m of branch.matchAll(/\$(\d+)s\d+/g)) ids.add(Number(m[1]));
    const effects = new Map();
    for (const id of ids) effects.set(id, await this._spellEffects(id));

    return renderSpellDescription({
      template,
      orderIndex,
      thisSpellId: Number(spellId),
      effects,
    });
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

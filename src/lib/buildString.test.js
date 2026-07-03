/**
 * Round-trip tests for the build-string parser/encoder.
 *
 * Run:  npm test   (or: npx vitest run src/lib/buildString.test.js)
 *
 * These guard the most dangerous failure mode of a data change: a build string
 * that silently misparses because the serialisation node set drifted. For every
 * implemented class+spec we:
 *   1. construct a deterministic selection (full and partial),
 *   2. encode it with generateBuildString,
 *   3. parse it back with parseBuildString,
 *   4. assert the round-trip is exact (header + every node's points & choice).
 *
 * Because encode and decode both derive their node order from collectClassNodes,
 * a self-consistent round-trip proves the encoder, decoder, partial-rank path,
 * choice path, and apex path all agree on the bit layout. The wire-layout
 * snapshot test (dataIntegrity.test.js) covers drift of that layout itself.
 */

import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  parseBuildString,
  generateBuildString,
  parseSpecId,
  collectClassNodes,
  heroGateSelection,
  SERIALIZATION_VERSION,
} from "./buildString.js";
import { BitWriter } from "./bitStream.js";

const require = createRequire(import.meta.url);
const classIndex = require("../data/classes.json");

// ── Selection builders ────────────────────────────────────────────────────────

/** Every non-granted spec node selected at full rank; choice nodes pick option 0. */
function fullSelection(specNodes) {
  const sel = {};
  for (const n of specNodes) {
    if (n.alreadyGranted) continue;
    sel[n.id] = {
      pointsInvested:
        n.type === "choice" ? (n.choices?.[0]?.maxRanks ?? 1) : n.maxRanks,
      entryChosen: n.type === "choice" ? 0 : null,
    };
  }
  return sel;
}

/**
 * A varied selection that exercises every code path:
 *   - multi-rank nodes at a PARTIAL rank (isPartiallyRanked branch)
 *   - choice nodes on their SECOND option (entryChosen = 1)
 *   - single-rank nodes fully purchased
 */
function variedSelection(specNodes) {
  const sel = {};
  for (const n of specNodes) {
    if (n.alreadyGranted) continue;
    if (n.type === "choice") {
      const opt = (n.choices?.length ?? 1) > 1 ? 1 : 0;
      sel[n.id] = {
        pointsInvested: n.choices?.[opt]?.maxRanks ?? 1,
        entryChosen: opt,
      };
    } else if (n.maxRanks > 1) {
      sel[n.id] = { pointsInvested: 1, entryChosen: null }; // partial: 1 of >1
    } else {
      sel[n.id] = { pointsInvested: 1, entryChosen: null };
    }
  }
  return sel;
}

/** Asserts two selection maps are exactly equal. */
function assertSameSelection(actual, expected, label) {
  const aIds = Object.keys(actual)
    .map(Number)
    .sort((x, y) => x - y);
  const eIds = Object.keys(expected)
    .map(Number)
    .sort((x, y) => x - y);
  assert.deepStrictEqual(aIds, eIds, `${label}: selected node IDs differ`);
  for (const id of eIds) {
    assert.strictEqual(
      actual[id].pointsInvested,
      expected[id].pointsInvested,
      `${label}: node ${id} pointsInvested mismatch`,
    );
    assert.strictEqual(
      actual[id].entryChosen ?? null,
      expected[id].entryChosen ?? null,
      `${label}: node ${id} entryChosen mismatch`,
    );
  }
}

// ── Per-class round-trip ──────────────────────────────────────────────────────

for (const cls of classIndex.filter((c) => c.implemented)) {
  const data = require(`../data/${cls.name}.json`);
  const classNodes = collectClassNodes(data);

  test("collectClassNodes is strictly ascending and unique", () => {
    for (let i = 1; i < classNodes.length; i++) {
      assert.ok(
        classNodes[i].id > classNodes[i - 1].id,
        `node order not strictly ascending at index ${i}`,
      );
    }
  });

  for (const slug of Object.keys(data.specs)) {
    const spec = data.specs[slug];
    const specNodes = spec.nodes;

    test(`${slug}: full selection round-trips`, () => {
      const sel = fullSelection(specNodes);
      const str = generateBuildString(sel, spec.specId, classNodes);
      const parsed = parseBuildString(str, classNodes);
      assert.strictEqual(parsed.specId, spec.specId, "specId mismatch");
      assertSameSelection(parsed.nodes, sel, `${slug} full`);
    });

    test(`${slug}: varied (partial ranks + 2nd choices) round-trips`, () => {
      const sel = variedSelection(specNodes);
      const str = generateBuildString(sel, spec.specId, classNodes);
      const parsed = parseBuildString(str, classNodes);
      assert.strictEqual(parsed.specId, spec.specId, "specId mismatch");
      assertSameSelection(parsed.nodes, sel, `${slug} varied`);
    });

    test(`${slug}: parseSpecId reads the header from a generated string`, () => {
      const str = generateBuildString(
        fullSelection(specNodes),
        spec.specId,
        classNodes,
      );
      const { specId, version } = parseSpecId(str);
      assert.strictEqual(specId, spec.specId, "header specId mismatch");
      assert.ok(Number.isInteger(version), "version should be an integer");
    });

    test(`${slug}: empty selection round-trips to nothing`, () => {
      const str = generateBuildString({}, spec.specId, classNodes);
      const parsed = parseBuildString(str, classNodes);
      assert.strictEqual(parsed.specId, spec.specId);
      assert.strictEqual(
        Object.keys(parsed.nodes).length,
        0,
        "expected no selected nodes",
      );
    });
  }
}

// ── Trailing-zero trimming ────────────────────────────────────────────────────
// A trailing run of unselected nodes serialises as all-zero records; a producer
// may drop those trailing zero characters. The parser must treat the missing
// node tail as unselected rather than throwing "Build string exhausted". (The
// 152-bit header — version + specId + the zero hash — is always kept; a string
// truncated inside the header or a selected node's fields stays a hard error.)
describe("parseBuildString tolerates a trimmed trailing-zero node tail", () => {
  const HEADER_BITS = 8 + 16 + 128; // version + specId + Blizzard hash
  const HEADER_CHARS = Math.ceil(HEADER_BITS / 6);
  const cls = classIndex.find((c) => c.implemented);
  const data = require(`../data/${cls.name}.json`);
  const classNodes = collectClassNodes(data);
  const slug = Object.keys(data.specs)[0];
  const spec = data.specs[slug];

  test("an empty selection with its all-zero node section dropped still decodes", () => {
    const full = generateBuildString({}, spec.specId, classNodes);
    // Keep only the header; every node record (all zero for an empty build) is
    // trimmed away — exactly the tail a minimal producer would omit.
    const trimmed = full.slice(0, HEADER_CHARS);
    assert.ok(trimmed.length < full.length, "expected a trimmable node tail");
    const parsed = parseBuildString(trimmed, classNodes);
    assert.strictEqual(parsed.specId, spec.specId);
    assert.strictEqual(Object.keys(parsed.nodes).length, 0);
  });

  test("a string truncated inside a selected node's record still throws", () => {
    // Header, then a node opened as selected + purchased + partially-ranked but
    // cut off before its 6-bit rank value. This is real corruption (a selected
    // record lost its own bits), not a trimmed all-zero tail, so it must throw
    // rather than be silently accepted — the guard only applies at the record
    // boundary (the isSelected bit), never mid-record.
    const w = new BitWriter();
    w.writeBits(SERIALIZATION_VERSION, 8);
    w.writeBits(spec.specId, 16);
    w.writeBits(0, 128);
    w.writeBit(1); // isSelected
    w.writeBit(1); // isPurchased
    w.writeBit(1); // isPartiallyRanked — obliges a 6-bit rank read that isn't there
    assert.throws(
      () => parseBuildString(w.toString(), classNodes),
      /exhausted/,
    );
  });

  test("a header truncated inside the Blizzard hash throws, not decodes as empty", () => {
    // version + specId present, but the 128-bit hash is cut short. Every real
    // export carries the full hash, so this is corruption. Without an eager bounds
    // check the hash-skip would run past the end and the first node-loop atEnd()
    // would treat it as a trimmed tail, silently yielding an empty build.
    //
    // Detection is at base64-char (6-bit) granularity: toString() pads the final
    // char with zeros, so a hash cut within the last few bits is padded back to a
    // full-length header and is indistinguishable from a valid one. That is not a
    // reachable input — base64 cannot carry a partial char — so the cases below
    // drop whole chars, which is how truncation actually manifests.
    const full = generateBuildString({}, spec.specId, classNodes);
    const headerChars = Math.ceil((8 + 16 + 128) / 6); // 26
    for (const chars of [4, 12, headerChars - 1]) {
      const truncated = full.slice(0, chars);
      assert.throws(
        () => parseBuildString(truncated, classNodes),
        /exhausted/,
        `expected throw for a header truncated to ${chars} chars`,
      );
    }
  });
});

// ── Encode clamps an out-of-range choice index (regression, finding #12) ──────
// A corrupt or hand-built selection can carry an entryChosen past a node's real
// option count (the 2-bit field encodes 0-3). The encoder must clamp it into a
// real option, exactly as the parser clamps on read, so the encode is not
// silently lossy: encoding the bogus index must produce the same bytes as
// encoding the clamped index, and the string must round-trip to that option.
describe("generateBuildString clamps an out-of-range choice index", () => {
  const data = require("../data/death_knight.json");
  const classNodes = collectClassNodes(data);

  let choiceNode = null;
  let specId = null;
  for (const slug of Object.keys(data.specs)) {
    const spec = data.specs[slug];
    const found = spec.nodes.find(
      (n) => n.type === "choice" && (n.choices?.length ?? 0) >= 2,
    );
    if (found) {
      choiceNode = found;
      specId = spec.specId;
      break;
    }
  }

  test("out-of-range entryChosen encodes identically to the clamped index", () => {
    assert.ok(choiceNode, "expected a 2+ option choice node in the data");
    const lastIdx = choiceNode.choices.length - 1;
    const points = choiceNode.choices[lastIdx]?.maxRanks ?? 1;
    // One past the last option — always out of range.
    const bogus = {
      [choiceNode.id]: {
        pointsInvested: points,
        entryChosen: choiceNode.choices.length,
      },
    };
    const clamped = {
      [choiceNode.id]: { pointsInvested: points, entryChosen: lastIdx },
    };
    const strBogus = generateBuildString(bogus, specId, classNodes);
    const strClamped = generateBuildString(clamped, specId, classNodes);
    assert.strictEqual(
      strBogus,
      strClamped,
      "encode should clamp the index, not emit a bogus one",
    );
    const parsed = parseBuildString(strBogus, classNodes);
    assert.strictEqual(
      parsed.nodes[choiceNode.id].entryChosen,
      lastIdx,
      "round-trips to the clamped option",
    );
  });
});

describe("generateBuildString treats an empty choices array as a non-choice node", () => {
  // A node with choices: [] is malformed (validateClassData rejects it), but a
  // hand-built classNodes could carry one. It must encode exactly like a
  // non-choice node — never as isChoice with entryIdx = choices.length - 1 = -1,
  // which writeBits(-1, 2) would otherwise turn into a stray entryChosen=3 plus
  // two bits that misalign every later node.
  const specId = 250;
  const selection = { 100: { pointsInvested: 1, entryChosen: 0 } };

  test("encodes identically to the same node with choices: null and round-trips", () => {
    const strEmpty = generateBuildString(selection, specId, [
      { id: 100, maxRanks: 1, choices: [] },
    ]);
    const strNull = generateBuildString(selection, specId, [
      { id: 100, maxRanks: 1, choices: null },
    ]);
    assert.strictEqual(
      strEmpty,
      strNull,
      "empty choices must encode like a non-choice node",
    );
    const parsed = parseBuildString(strEmpty, [
      { id: 100, maxRanks: 1, choices: null },
    ]);
    assert.strictEqual(parsed.nodes[100].pointsInvested, 1);
    assert.strictEqual(
      parsed.nodes[100].entryChosen,
      null,
      "a non-choice node reports entryChosen null, not a stray index",
    );
  });
});

// ── Error paths ───────────────────────────────────────────────────────────────
// A truncated or corrupt string must fail loudly, never return garbage — the
// store relies on these throws to mark a build as "failed to parse".

describe("error handling", () => {
  const TINY = [{ id: 1, maxRanks: 1, choices: null }];

  test("parseBuildString rejects a non-string", () => {
    assert.throws(() => parseBuildString(null, TINY), TypeError);
    assert.throws(() => parseBuildString("", TINY), /non-empty string/);
  });

  test("parseBuildString rejects an empty / non-array node list", () => {
    assert.throws(() => parseBuildString("AAAAAAAA", []), /non-empty array/);
    assert.throws(() => parseBuildString("AAAAAAAA", null), /non-empty array/);
  });

  test("parseBuildString throws on an invalid base64 character", () => {
    assert.throws(() => parseBuildString("@@@@@@", TINY), /Invalid character/);
  });

  test("parseBuildString throws when the stream is exhausted (truncated)", () => {
    // 'CA' = a valid v2 version byte (so it passes the version gate) but only
    // 12 bits total, while the header needs 24 — runs out mid-header.
    assert.throws(() => parseBuildString("CA", TINY), /exhausted/);
  });

  test("parseBuildString rejects an unsupported serialisation version", () => {
    // 'AA' decodes to version 0; only version 2 is supported.
    assert.throws(
      () => parseBuildString("AAAAAAAA", TINY),
      /Unsupported build string version 0/,
    );
  });

  test("parseSpecId rejects an unsupported serialisation version", () => {
    assert.throws(
      () => parseSpecId("AAAAAAAA"),
      /Unsupported build string version 0/,
    );
  });

  test("parseSpecId rejects a non-string", () => {
    assert.throws(() => parseSpecId(undefined), /non-empty string/);
  });

  test("parseSpecId throws when too short for the 24-bit header", () => {
    assert.throws(() => parseSpecId("A"), /exhausted/);
  });

  test("a generated string survives padding being stripped", () => {
    // BitReader strips trailing "=" — make sure a padded string still parses.
    const data = require("../data/death_knight.json");
    const nodes = collectClassNodes(data);
    const str = generateBuildString({}, data.specs.blood.specId, nodes);
    assert.strictEqual(parseSpecId(str + "==").specId, data.specs.blood.specId);
  });

  test("choice node with a null entryChosen round-trips its rank", () => {
    // node.maxRanks (1) differs from the chosen option's maxRanks (3). A null
    // entryChosen must resolve maxRanks via the written index (0), so the partial
    // flag agrees with decode and pointsInvested is preserved rather than snapping
    // to the option's full rank.
    const nodes = [
      { id: 1, maxRanks: 1, choices: [{ maxRanks: 3 }, { maxRanks: 3 }] },
    ];
    const str = generateBuildString(
      { 1: { pointsInvested: 2, entryChosen: null } },
      250,
      nodes,
    );
    const parsed = parseBuildString(str, nodes);
    assert.strictEqual(parsed.nodes[1].pointsInvested, 2);
    assert.strictEqual(parsed.nodes[1].entryChosen, 0);
  });
});

// ── Hardening against corrupt input ───────────────────────────────────────────

describe("parseBuildString clamps an over-max partial rank", () => {
  const CHARSET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  // LSB-first bit packing, mirroring the encoder, so we can hand-craft a stream
  // the encoder itself would never emit (a partial rank above the node's max).
  const pushInt = (bits, value, count) => {
    for (let i = 0; i < count; i++) bits.push((value >> i) & 1);
  };
  const bitsToStr = (bits) => {
    const b = [...bits];
    while (b.length % 6 !== 0) b.push(0);
    let out = "";
    for (let i = 0; i < b.length; i += 6) {
      let v = 0;
      for (let j = 0; j < 6; j++) v |= b[i + j] << j;
      out += CHARSET[v];
    }
    return out;
  };

  test("a partial value beyond maxRanks is capped to the node max", () => {
    const bits = [];
    pushInt(bits, 2, 8); // version
    pushInt(bits, 250, 16); // specId
    for (let i = 0; i < 128; i++) bits.push(0); // hash
    // One node (id 100, maxRanks 5): selected, purchased, partially-ranked with a
    // corrupt rank of 63, non-choice.
    bits.push(1, 1, 1);
    pushInt(bits, 63, 6);
    bits.push(0);

    const parsed = parseBuildString(bitsToStr(bits), [
      { id: 100, maxRanks: 5, choices: null },
    ]);
    assert.strictEqual(parsed.nodes[100].pointsInvested, 5);
  });

  test("an out-of-range choice index is clamped into a real option", () => {
    const bits = [];
    pushInt(bits, 2, 8); // version
    pushInt(bits, 250, 16); // specId
    for (let i = 0; i < 128; i++) bits.push(0); // hash
    // One 2-option choice node (id 100): selected, purchased, not partially
    // ranked, choice node with a corrupt entryChosen of 3 (only 0/1 are valid).
    bits.push(1, 1, 0, 1);
    pushInt(bits, 3, 2);

    const parsed = parseBuildString(bitsToStr(bits), [
      { id: 100, maxRanks: 1, choices: [{ maxRanks: 1 }, { maxRanks: 1 }] },
    ]);
    // Clamped to the last valid index so it can't index past choices[].
    assert.strictEqual(parsed.nodes[100].entryChosen, 1);
  });

  test("a choice bit on a non-choice node yields entryChosen null", () => {
    const bits = [];
    pushInt(bits, 2, 8); // version
    pushInt(bits, 250, 16); // specId
    for (let i = 0; i < 128; i++) bits.push(0); // hash
    // One non-choice node (id 100, choices: null): selected, purchased, not
    // partially ranked, but the stream nonetheless sets the isChoiceNode bit and
    // a 2-bit index — what a hand-crafted string or a version skew could carry.
    bits.push(1, 1, 0, 1);
    pushInt(bits, 1, 2);

    const parsed = parseBuildString(bitsToStr(bits), [
      { id: 100, maxRanks: 1, choices: null },
    ]);
    // The node has no choices, so entryChosen must be null per the contract — not
    // the stray index the bitstream carried, which diff/heatmap would otherwise
    // read as a difference.
    assert.strictEqual(parsed.nodes[100].pointsInvested, 1);
    assert.strictEqual(parsed.nodes[100].entryChosen, null);
  });

  test("a partially-ranked value of 0 drops the node entirely", () => {
    const bits = [];
    pushInt(bits, 2, 8); // version
    pushInt(bits, 250, 16); // specId
    for (let i = 0; i < 128; i++) bits.push(0); // hash
    // One node (id 100, maxRanks 5): selected, purchased, partially-ranked with a
    // nonsensical rank of 0, non-choice.
    bits.push(1, 1, 1);
    pushInt(bits, 0, 6);
    bits.push(0);

    const parsed = parseBuildString(bitsToStr(bits), [
      { id: 100, maxRanks: 5, choices: null },
    ]);
    // A purchased-but-zero node is corrupt; it must not appear as selected.
    assert.strictEqual(parsed.nodes[100], undefined);
  });
});

describe("heroGateSelection", () => {
  test("returns null when no hero points are invested", () => {
    assert.strictEqual(heroGateSelection(0, false), null);
    assert.strictEqual(heroGateSelection(0, true), null);
  });

  test("encodes the active subtree as entryChosen (0 = left, 1 = right)", () => {
    assert.deepStrictEqual(heroGateSelection(3, false), {
      pointsInvested: 1,
      entryChosen: 0,
    });
    assert.deepStrictEqual(heroGateSelection(5, true), {
      pointsInvested: 1,
      entryChosen: 1,
    });
  });
});

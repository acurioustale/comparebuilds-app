/**
 * src/lib/bitStream.js
 *
 * Bitstream reading and writing utilities for World of Warcraft talent build strings.
 */

// ─── Character table ─────────────────────────────────────────────────────────

const CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** @type {Map<string, number>} char → 0-63 */
const CHAR_TO_VAL = new Map(CHARSET.split("").map((c, i) => [c, i]));

// ─── Bit reader ───────────────────────────────────────────────────────────────

const PADDING_RE = /=+$/;

export class BitReader {
  /** @type {string} */ #str;
  /** @type {number} */ #pos = 0;

  /** @param {string} buildString  Base64 string, padding stripped internally. */
  constructor(buildString) {
    this.#str = buildString.replace(PADDING_RE, "");
  }

  readBit() {
    const charIdx = (this.#pos / 6) | 0;
    if (charIdx >= this.#str.length) {
      throw new RangeError(`Build string exhausted at bit ${this.#pos}`);
    }
    const val = CHAR_TO_VAL.get(this.#str[charIdx]);
    if (val === undefined) {
      throw new TypeError(
        `Invalid character '${this.#str[charIdx]}' at index ${charIdx}`,
      );
    }
    // LSB-first within each 6-bit character: bit j = (val >> j) & 1
    const bit = (val >> (this.#pos % 6)) & 1;
    this.#pos++;
    return bit;
  }

  /** Read `count` bits, assembled LSB-first into an unsigned integer. */
  readBits(count) {
    let result = 0;
    for (let i = 0; i < count; i++) {
      result |= this.readBit() << i;
    }
    return result;
  }

  /** Advance position by `count` bits (validates bounds lazily on next readBit). */
  skipBits(count) {
    this.#pos += count;
  }
}

// ─── Bit writer ───────────────────────────────────────────────────────────────

export class BitWriter {
  #bits = [];

  writeBit(bit) {
    this.#bits.push(bit & 1);
  }

  // NOTE: only safe for count <= 31 with non-zero values — JS masks shift amounts
  // to 5 bits, so (value >> i) is wrong for i >= 32. All real fields here are <= 16
  // bits; the only wide write is the 128-bit hash, which is always 0.
  writeBits(value, count) {
    for (let i = 0; i < count; i++) this.#bits.push((value >> i) & 1);
  }

  toString() {
    const bits = [...this.#bits];
    while (bits.length % 6 !== 0) bits.push(0);
    let out = "";
    for (let i = 0; i < bits.length; i += 6) {
      let v = 0;
      for (let j = 0; j < 6; j++) v |= bits[i + j] << j;
      out += CHARSET[v];
    }
    return out;
  }
}

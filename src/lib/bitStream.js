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

  /**
   * @param {string} buildString  Base64 string; whitespace and padding stripped
   *   internally.
   */
  constructor(buildString) {
    // Base64 build strings never contain whitespace, but a value can pick one up
    // in transit — a trailing newline from a share-API payload, or a stray space
    // from a copy-paste — on paths that don't trim before parsing (share
    // rehydration hands addBuild the raw payload). A stray char would otherwise
    // throw in readBit() and the whole build would be shown as invalid. Strip all
    // whitespace so a structurally valid string still parses; padding after.
    this.#str = buildString.replace(/\s+/g, "").replace(PADDING_RE, "");
  }

  /**
   * Whether the next `readBit()` would run past the end of the stream. Lets a
   * caller treat an exhausted tail as implicit zero bits (e.g. a build string
   * whose trailing all-zero — unselected — node records were trimmed) instead of
   * forcing every producer to pad to the full node count.
   * @returns {boolean} True when no more bits remain
   */
  atEnd() {
    return ((this.#pos / 6) | 0) >= this.#str.length;
  }

  /**
   * Reads a single bit from the stream.
   * @returns {number} 0 or 1
   */
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

  /**
   * Read `count` bits, assembled LSB-first into an unsigned integer.
   * @param {number} count Number of bits to read
   * @returns {number} Unsigned integer value
   */
  readBits(count) {
    if (count > 53) {
      throw new RangeError(
        `Cannot safely read more than 53 bits into a JS number (requested ${count})`,
      );
    }
    let result = 0;
    for (let i = 0; i < count; i++) {
      result += this.readBit() * 2 ** i;
    }
    return result;
  }

  /**
   * Advance position by `count` bits. Validates eagerly that the bits exist: the
   * only caller skips the fixed 128-bit Blizzard hash, which every real export
   * carries in full, so a string too short to hold it is truncated inside the
   * header and must fail loudly here. Deferring to the next read would not catch
   * it — the parser's next operation is atEnd(), which treats a past-end position
   * as a legitimately trimmed tail and would decode the truncated string as an
   * empty build instead of rejecting it.
   * @param {number} count Number of bits to skip
   * @returns {void}
   */
  skipBits(count) {
    if (this.#pos + count > this.#str.length * 6) {
      throw new RangeError(
        `Build string exhausted: cannot skip ${count} bits at bit ${this.#pos}`,
      );
    }
    this.#pos += count;
  }
}

// ─── Bit writer ───────────────────────────────────────────────────────────────

export class BitWriter {
  #bits = [];

  /**
   * Writes a single bit to the stream.
   * @param {number} bit 0 or 1
   * @returns {void}
   */
  writeBit(bit) {
    this.#bits.push(bit & 1);
  }

  // NOTE: only safe for count <= 31 with non-zero values — JS masks shift amounts
  // to 5 bits, so (value >> i) is wrong for i >= 32. All real fields here are <= 16
  // bits; the only wide write is the 128-bit hash, which is always 0.
  /**
   * Writes `count` bits of `value` to the stream.
   * @param {number} value Non-negative integer value to write
   * @param {number} count Number of bits to write
   * @returns {void}
   */
  writeBits(value, count) {
    // Every wire field is an unsigned integer. A non-integer (NaN, a float, a
    // bad computation) would be coerced by the shift below into arbitrary bits,
    // silently corrupting the stream — reject it up front.
    if (!Number.isInteger(value)) {
      throw new RangeError(
        `Cannot write a non-integer value (${value}); all bitstream fields are unsigned integers`,
      );
    }
    // A negative value would be written as its two's-complement low bits — e.g.
    // writeBits(-1, 2) emits (1,1), silently encoding 3 — so a caller that
    // computed a negative (an out-of-range index, a bad subtraction) corrupts
    // the stream instead of failing. Reject it here.
    if (value < 0) {
      throw new RangeError(
        `Cannot write a negative value (${value}); all bitstream fields are unsigned`,
      );
    }
    if (count > 31 && value !== 0) {
      throw new RangeError(
        `Cannot safely write non-zero values for count > 31 (requested ${count})`,
      );
    }
    // A value wider than `count` bits would be silently truncated to its low
    // `count` bits (the shift below only reads i < count) — e.g. a specId >=
    // 65536 written in 16 bits would decode as a different, possibly nonexistent
    // spec. Reject the overflow so a caller fails loudly instead. (count > 31 is
    // already constrained to value 0 above, so this only needs to cover <= 31.)
    if (count <= 31 && value > 2 ** count - 1) {
      throw new RangeError(
        `Value ${value} does not fit in ${count} bits (max ${2 ** count - 1})`,
      );
    }
    for (let i = 0; i < count; i++) this.#bits.push((value >> i) & 1);
  }

  /**
   * Converts the written bitstream to a base64 string.
   * @returns {string} Base64 build string
   */
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

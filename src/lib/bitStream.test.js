import { describe, test, expect } from "vitest";
import { BitReader, BitWriter } from "./bitStream.js";

describe("bitStream safe shift handling", () => {
  test("BitReader.readBits throws RangeError for count > 53", () => {
    const reader = new BitReader("AAAAAAAA");
    expect(() => reader.readBits(54)).toThrow(RangeError);
  });

  test("BitWriter.writeBits throws RangeError for count > 31 with non-zero value", () => {
    const writer = new BitWriter();
    expect(() => writer.writeBits(1, 32)).toThrow(RangeError);
  });

  test("BitWriter.writeBits succeeds for count > 31 when value is 0", () => {
    const writer = new BitWriter();
    expect(() => writer.writeBits(0, 128)).not.toThrow();
  });

  test("BitWriter.writeBits throws RangeError for a negative value", () => {
    const writer = new BitWriter();
    // Left unguarded this would emit two's-complement low bits (1,1) = 3
    // rather than failing, silently corrupting the stream.
    expect(() => writer.writeBits(-1, 2)).toThrow(RangeError);
  });

  test("BitWriter.writeBits throws RangeError for a value wider than count bits", () => {
    const writer = new BitWriter();
    // A specId >= 65536 in a 16-bit field would otherwise be truncated to its
    // low 16 bits (70000 & 0xffff = 4464) and decode as a different spec.
    expect(() => writer.writeBits(70000, 16)).toThrow(RangeError);
    // The exact boundary: 2^count - 1 fits, 2^count does not.
    expect(() => writer.writeBits(65535, 16)).not.toThrow();
    expect(() => writer.writeBits(65536, 16)).toThrow(RangeError);
  });

  test("BitWriter.writeBits throws RangeError for a non-integer value", () => {
    const writer = new BitWriter();
    expect(() => writer.writeBits(2.5, 8)).toThrow(RangeError);
    expect(() => writer.writeBits(NaN, 8)).toThrow(RangeError);
  });

  test("BitReader.atEnd reports exhaustion at the string boundary", () => {
    const reader = new BitReader("A"); // one 6-bit character
    for (let i = 0; i < 6; i++) {
      expect(reader.atEnd()).toBe(false);
      reader.readBit();
    }
    expect(reader.atEnd()).toBe(true);
    // The next read past the end still throws — atEnd is a probe, not a mute.
    expect(() => reader.readBit()).toThrow(RangeError);
  });

  test("BitReader.skipBits throws when the skip runs past the end", () => {
    const reader = new BitReader("AA"); // two chars = 12 bits available
    expect(() => reader.skipBits(13)).toThrow(RangeError);
  });

  test("BitReader.skipBits advances within bounds without throwing", () => {
    const reader = new BitReader("AA"); // 12 bits
    reader.skipBits(12); // exactly to the end is allowed
    expect(reader.atEnd()).toBe(true);
  });
});

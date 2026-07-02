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
});

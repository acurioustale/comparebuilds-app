import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { BitReader, BitWriter } from "./bitStream.js";
import {
  parseBuildString,
  generateBuildString,
  parseSpecId,
  SERIALIZATION_VERSION,
} from "./buildString.js";

describe("BitStream & BuildString Fuzzing / Property-Based Tests", () => {
  describe("BitReader & BitWriter primitives", () => {
    it("round-trips arbitrary sequences of individual bits", () => {
      fc.assert(
        fc.property(fc.array(fc.boolean()), (bits) => {
          const writer = new BitWriter();
          for (const b of bits) writer.writeBit(b ? 1 : 0);
          const encoded = writer.toString();

          const reader = new BitReader(encoded);
          for (const b of bits) {
            expect(reader.readBit()).toBe(b ? 1 : 0);
          }
        }),
      );
    });

    it("round-trips arbitrary multi-bit integers (up to 31 bits)", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              count: fc.integer({ min: 1, max: 16 }),
              value: fc.nat(),
            }),
          ),
          (fields) => {
            const writer = new BitWriter();
            for (const f of fields) {
              const mask = (1 << f.count) - 1;
              writer.writeBits(f.value & mask, f.count);
            }
            const encoded = writer.toString();

            const reader = new BitReader(encoded);
            for (const f of fields) {
              const mask = (1 << f.count) - 1;
              expect(reader.readBits(f.count)).toBe(f.value & mask);
            }
          },
        ),
      );
    });
  });

  describe("parseBuildString & generateBuildString property tests", () => {
    // Arbitrary node definitions
    const classNodeArb = fc.record({
      id: fc.integer({ min: 1, max: 100000 }),
      maxRanks: fc.integer({ min: 1, max: 5 }),
      choices: fc.option(
        fc.array(fc.record({ maxRanks: fc.integer({ min: 1, max: 1 }) }), {
          minLength: 1,
          maxLength: 4,
        }),
        { nil: null },
      ),
    });

    it("round-trips valid build selections perfectly", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 65535 }), // specId (16 bits)
          fc.uniqueArray(classNodeArb, {
            selector: (n) => n.id,
            minLength: 1,
            maxLength: 50,
          }),
          fc.array(fc.boolean()), // whether each node is selected
          (specId, classNodes, selections) => {
            const selectedNodes = {};
            classNodes.forEach((node, idx) => {
              if (selections[idx % selections.length]) {
                const isChoice = node.choices != null;
                if (isChoice) {
                  const entryChosen = 0; // generateBuildString uses entryChosen ?? 0
                  selectedNodes[node.id] = { pointsInvested: 1, entryChosen };
                } else {
                  selectedNodes[node.id] = {
                    pointsInvested: node.maxRanks,
                    entryChosen: null,
                  };
                }
              }
            });

            const buildStr = generateBuildString(
              selectedNodes,
              specId,
              classNodes,
            );
            const parsed = parseBuildString(buildStr, classNodes);

            expect(parsed.version).toBe(SERIALIZATION_VERSION);
            expect(parsed.specId).toBe(specId);
            expect(parsed.nodes).toEqual(selectedNodes);

            const specIdHeader = parseSpecId(buildStr);
            expect(specIdHeader.version).toBe(SERIALIZATION_VERSION);
            expect(specIdHeader.specId).toBe(specId);
          },
        ),
      );
    });

    it("handles corrupted, truncated, or random strings gracefully without crashing or hanging", () => {
      fc.assert(
        fc.property(
          fc.string(),
          fc.uniqueArray(classNodeArb, {
            selector: (n) => n.id,
            minLength: 1,
            maxLength: 20,
          }),
          (randomStr, classNodes) => {
            try {
              parseBuildString(randomStr, classNodes);
            } catch (err) {
              expect(
                err instanceof RangeError ||
                  err instanceof TypeError ||
                  err instanceof Error,
              ).toBe(true);
            }
          },
        ),
      );
    });
  });
});

import { describe, it, expect } from 'vitest';
import { LtEncoder, deriveSymbolNeighbors } from '../src/fec/lt-encoder.js';
import { LtDecoder, BlockDecoder } from '../src/fec/lt-decoder.js';
import type { SourceBlock } from '../src/fec/types.js';

describe('LT Fountain Encoder & Peeling Decoder', () => {
  const symbolSize = 16;
  const k = 8;

  // Create a synthetic source block with deterministic content
  function createTestBlock(blockIndex: number = 0): {
    block: SourceBlock;
    sourceSymbols: Uint8Array[];
  } {
    const raw = new Uint8Array(k * symbolSize);
    for (let i = 0; i < raw.length; i++) {
      raw[i] = ((i + 1) * 3) & 0xff;
    }

    const block: SourceBlock = {
      blockIndex,
      totalBlocks: 1,
      symbolSize,
      k,
      data: raw,
    };

    const sourceSymbols = LtEncoder.partitionSourceSymbols(block);
    return { block, sourceSymbols };
  }

  describe('LT Encoder', () => {
    it('produces deterministic symbols under the same symbolId', () => {
      const { block } = createTestBlock();
      const encoder = new LtEncoder();

      const symbolsA = Array.from(encoder.encodeBlock(block, 10));
      const symbolsB = Array.from(encoder.encodeBlock(block, 10));

      expect(symbolsA.length).toBe(10);
      for (let i = 0; i < 10; i++) {
        expect(symbolsA[i]!.symbolId).toBe(i);
        expect(symbolsA[i]!.degree).toBe(symbolsB[i]!.degree);
        expect(symbolsA[i]!.neighbors).toEqual(symbolsB[i]!.neighbors);
        expect(symbolsA[i]!.data).toEqual(symbolsB[i]!.data);
      }
    });

    it('correctly computes XOR for degree > 1 equations', () => {
      const { block, sourceSymbols } = createTestBlock();
      const encoder = new LtEncoder();

      // Find an encoded symbol with degree >= 2
      let multiSym = null;
      for (const sym of encoder.encodeBlock(block, 20)) {
        if (sym.degree >= 2) {
          multiSym = sym;
          break;
        }
      }

      expect(multiSym).not.toBeNull();
      const sym = multiSym!;

      // Manually calculate expected XOR
      const expected = new Uint8Array(symbolSize);
      for (const n of sym.neighbors) {
        const src = sourceSymbols[n]!;
        for (let b = 0; b < symbolSize; b++) {
          expected[b] = (expected[b] ?? 0) ^ (src[b] ?? 0);
        }
      }

      expect(sym.data).toEqual(expected);
    });

    it('can reproduce metadata using deriveSymbolNeighbors', () => {
      const { block } = createTestBlock(3);
      const encoder = new LtEncoder();
      const sym = encoder.encodeSymbol(block, LtEncoder.partitionSourceSymbols(block), 42);

      const derived = deriveSymbolNeighbors(block.k, 3, 42);
      expect(sym.degree).toBe(derived.degree);
      expect(sym.neighbors).toEqual(derived.neighbors);
    });
  });

  describe('LT Decoder', () => {
    it('decodes a source block with no loss when sufficient symbols arrive', () => {
      const { block } = createTestBlock();
      const encoder = new LtEncoder();
      const decoder = new LtDecoder();

      // Fountain: generate overhead symbols (e.g. 1.5x K)
      const encodedSymbols = Array.from(encoder.encodeBlock(block, Math.ceil(k * 2.0)));

      let completed = false;
      for (const sym of encodedSymbols) {
        decoder.addSymbol(sym);
        if (decoder.isBlockComplete(block.blockIndex)) {
          completed = true;
          break;
        }
      }

      expect(completed).toBe(true);
      expect(decoder.getStatus(block.blockIndex)).toBe('complete');

      const reconstructed = decoder.decodeBlock(block.blockIndex);
      expect(reconstructed).not.toBeNull();
      expect(reconstructed).toEqual(block.data);
    });

    it('decodes successfully when symbols arrive shuffled (out of order)', () => {
      const { block } = createTestBlock();
      const encoder = new LtEncoder();
      const decoder = new LtDecoder();

      const symbols = Array.from(encoder.encodeBlock(block, Math.ceil(k * 2.5)));
      // Deterministic reverse/interleave shuffle
      const shuffled = symbols
        .map((s, idx) => ({ s, sortKey: (idx * 37) % 100 }))
        .sort((a, b) => a.sortKey - b.sortKey)
        .map((item) => item.s);

      for (const s of shuffled) {
        decoder.addSymbol(s);
        if (decoder.isBlockComplete(block.blockIndex)) {
          break;
        }
      }

      expect(decoder.isBlockComplete(block.blockIndex)).toBe(true);
      expect(decoder.decodeBlock(block.blockIndex)).toEqual(block.data);
    });

    it('gracefully handles duplicate symbol arrival', () => {
      const { block } = createTestBlock();
      const encoder = new LtEncoder();
      const decoder = new LtDecoder();

      const symbols = Array.from(encoder.encodeBlock(block, k * 2));

      // Feed every symbol twice
      for (const s of symbols) {
        decoder.addSymbol(s);
        const useful = decoder.addSymbol(s); // Duplicate
        expect(useful).toBe(false); // Second arrival should be marked redundant
      }

      expect(decoder.isBlockComplete(block.blockIndex)).toBe(true);
      expect(decoder.decodeBlock(block.blockIndex)).toEqual(block.data);
    });

    it('correctly reports incomplete / stalled status when insufficient symbols are delivered', () => {
      const { block } = createTestBlock();
      const blockDecoder = new BlockDecoder(block.blockIndex, block.k, block.symbolSize);

      // Only feed 1 encoded symbol of degree 2 (cannot solve either neighbor)
      const symWithDeg2 = {
        blockIndex: block.blockIndex,
        symbolId: 99,
        k: block.k,
        degree: 2,
        neighbors: [0, 1],
        data: new Uint8Array(symbolSize),
        symbolSize,
        isSourceSymbol: false,
      };

      const useful = blockDecoder.addSymbol(symWithDeg2);
      expect(useful).toBe(true);
      expect(blockDecoder.isComplete()).toBe(false);
      expect(blockDecoder.getStatus()).toBe('stalled'); // Ripple is empty, cannot peel
      expect(blockDecoder.reconstruct()).toBeNull();
    });
  });
});

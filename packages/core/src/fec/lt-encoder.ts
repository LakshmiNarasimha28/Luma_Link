import { Prng } from './prng.js';
import {
  RobustSolitonDistribution,
  RobustSolitonConfig,
  DEFAULT_SOLITON_CONFIG,
} from './distribution.js';
import type { FecEncoder, FecScheme, SourceBlock, LtEncodedSymbol } from './types.js';

/**
 * Derives a deterministic 32-bit seed for a specific block and symbol index.
 * Uses 32-bit golden-ratio and prime multipliers to avoid seed collisions.
 */
export function deriveSymbolSeed(blockIndex: number, symbolId: number): number {
  let h = ((blockIndex * 0x9e3779b9) ^ (symbolId * 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Deterministically derives the degree and source symbol neighbor set for an encoded symbol.
 */
export function deriveSymbolNeighbors(
  k: number,
  blockIndex: number,
  symbolId: number,
  distribution?: RobustSolitonDistribution,
): { degree: number; neighbors: number[] } {
  const dist = distribution ?? new RobustSolitonDistribution(k);
  const seed = deriveSymbolSeed(blockIndex, symbolId);
  const prng = new Prng(seed);
  const degree = dist.sampleDegree(prng);
  const neighbors = dist.sampleNeighbors(degree, prng);
  return { degree, neighbors };
}

/**
 * Luby Transform (LT) Fountain Encoder.
 *
 * Transforms K source symbols into an unbounded stream of encoded symbols
 * by computing the bitwise XOR of pseudo-randomly selected source symbol subsets.
 */
export class LtEncoder implements FecEncoder {
  readonly scheme: FecScheme = 'lt-fountain';
  private readonly solitonConfig: RobustSolitonConfig;

  constructor(solitonConfig: RobustSolitonConfig = DEFAULT_SOLITON_CONFIG) {
    this.solitonConfig = solitonConfig;
  }

  /**
   * Partitions source block bytes into K individual source symbol buffers.
   */
  static partitionSourceSymbols(block: SourceBlock): Uint8Array[] {
    const symbols: Uint8Array[] = new Array<Uint8Array>(block.k);
    for (let i = 0; i < block.k; i++) {
      const start = i * block.symbolSize;
      const end = start + block.symbolSize;
      // Extract exact symbol slice
      symbols[i] = block.data.subarray(start, end);
    }
    return symbols;
  }

  /**
   * Generates a single encoded symbol for the given block and symbolId.
   */
  encodeSymbol(
    block: SourceBlock,
    sourceSymbols: readonly Uint8Array[],
    symbolId: number,
    distribution?: RobustSolitonDistribution,
  ): LtEncodedSymbol {
    const dist = distribution ?? new RobustSolitonDistribution(block.k, this.solitonConfig);
    const { degree, neighbors } = deriveSymbolNeighbors(block.k, block.blockIndex, symbolId, dist);

    // Initialize accumulator buffer for XOR combination
    const data = new Uint8Array(block.symbolSize);
    for (const neighborIdx of neighbors) {
      const src = sourceSymbols[neighborIdx];
      if (!src) {
        throw new Error(`Invalid neighbor index ${neighborIdx} for K=${block.k}`);
      }
      for (let b = 0; b < block.symbolSize; b++) {
        data[b] = (data[b] ?? 0) ^ (src[b] ?? 0);
      }
    }

    return {
      blockIndex: block.blockIndex,
      symbolId,
      k: block.k,
      degree,
      neighbors,
      data,
      symbolSize: block.symbolSize,
      isSourceSymbol: degree === 1,
    };
  }

  /**
   * Generates an iterable sequence of encoded symbols for the given block.
   * If count is provided, yields exactly `count` symbols (symbolId 0 to count - 1).
   */
  *encodeBlock(block: SourceBlock, count?: number): Iterable<LtEncodedSymbol> {
    const sourceSymbols = LtEncoder.partitionSourceSymbols(block);
    const dist = new RobustSolitonDistribution(block.k, this.solitonConfig);

    let symbolId = 0;
    while (count === undefined || symbolId < count) {
      yield this.encodeSymbol(block, sourceSymbols, symbolId, dist);
      symbolId++;
    }
  }
}

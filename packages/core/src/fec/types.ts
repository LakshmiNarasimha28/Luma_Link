/**
 * Forward Error Correction (FEC) / Fountain coding abstractions for LumaLink.
 * Designed to be strictly pluggable (e.g. Luby Transform, RaptorQ).
 */

export type FecScheme = 'none' | 'xor-parity' | 'lt-fountain' | 'raptor';

export interface SourceBlock {
  readonly blockIndex: number;
  readonly totalBlocks: number;
  readonly data: Uint8Array;
  readonly symbolSize: number;
  /** Number of source symbols in this block (K) */
  readonly k: number;
}

export interface SourceSymbol {
  readonly blockIndex: number;
  readonly symbolIndex: number;
  readonly data: Uint8Array;
}

export interface FecSymbol {
  readonly blockIndex: number;
  readonly symbolId: number;
  readonly data: Uint8Array;
  readonly isSourceSymbol: boolean;
  readonly k?: number;
  readonly degree?: number;
  readonly neighbors?: readonly number[];
  readonly symbolSize?: number;
}

export interface LtEncodedSymbol extends FecSymbol {
  /** Number of source symbols in the block */
  readonly k: number;
  /** Degree of the equation (number of combined source symbols) */
  readonly degree: number;
  /** Sorted indices of source symbols XORed into this symbol */
  readonly neighbors: readonly number[];
  readonly symbolSize: number;
}

export type DecoderStatus = 'incomplete' | 'complete' | 'stalled';

export interface FecEncoder {
  readonly scheme: FecScheme;
  encodeBlock(block: SourceBlock, count?: number): Iterable<FecSymbol>;
}

export interface FecDecoder {
  readonly scheme: FecScheme;
  addSymbol(symbol: FecSymbol): boolean;
  isBlockComplete(blockIndex: number): boolean;
  getStatus(blockIndex: number): DecoderStatus;
  decodeBlock(blockIndex: number): Uint8Array | null;
}

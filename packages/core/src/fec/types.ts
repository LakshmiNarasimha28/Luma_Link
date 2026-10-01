/**
 * Forward Error Correction (FEC) / Fountain coding abstractions for LumaLink.
 * Designed to be strictly pluggable (e.g. XOR parity, Luby Transform, RaptorQ).
 */

export type FecScheme = 'none' | 'xor-parity' | 'lt-fountain' | 'raptor';

export interface SourceBlock {
  readonly blockIndex: number;
  readonly totalBlocks: number;
  readonly data: Uint8Array;
  readonly symbolSize: number;
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
}

export interface FecEncoder {
  readonly scheme: FecScheme;
  encodeBlock(block: SourceBlock): Iterable<FecSymbol>;
}

export interface FecDecoder {
  readonly scheme: FecScheme;
  addSymbol(symbol: FecSymbol): boolean;
  isBlockComplete(blockIndex: number): boolean;
  decodeBlock(blockIndex: number): Uint8Array | null;
}

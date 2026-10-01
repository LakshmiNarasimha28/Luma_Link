import { deriveSymbolNeighbors } from './lt-encoder.js';
import type { FecDecoder, FecScheme, FecSymbol, LtEncodedSymbol, DecoderStatus } from './types.js';

interface Equation {
  data: Uint8Array;
  unresolvedNeighbors: Set<number>;
}

/**
 * Single-block peeling decoder for Luby Transform fountain codes.
 */
export class BlockDecoder {
  readonly blockIndex: number;
  readonly k: number;
  readonly symbolSize: number;

  private readonly sourceSymbols: Array<Uint8Array | null>;
  private recoveredCount: number = 0;

  // Active linear equations with degree > 1
  private readonly equations: Set<Equation> = new Set();
  // Reverse index mapping each unresolved source index to equations containing it
  private readonly sourceToEquations: Map<number, Set<Equation>> = new Map();
  // Ripple queue containing degree-1 equations ready to be peeled
  private readonly rippleQueue: Equation[] = [];
  // Set of received symbol IDs to immediately reject duplicate arrivals
  private readonly receivedSymbolIds: Set<number> = new Set();

  constructor(blockIndex: number, k: number, symbolSize: number) {
    if (k < 1) {
      throw new RangeError(`K must be >= 1, received ${k}`);
    }
    if (symbolSize < 1) {
      throw new RangeError(`symbolSize must be >= 1, received ${symbolSize}`);
    }
    this.blockIndex = blockIndex;
    this.k = k;
    this.symbolSize = symbolSize;
    this.sourceSymbols = new Array<Uint8Array | null>(k).fill(null);
  }

  get recoveredSymbolCount(): number {
    return this.recoveredCount;
  }

  isComplete(): boolean {
    return this.recoveredCount === this.k;
  }

  getStatus(): DecoderStatus {
    if (this.isComplete()) {
      return 'complete';
    }
    if (this.rippleQueue.length === 0) {
      return 'stalled';
    }
    return 'incomplete';
  }

  /**
   * Adds an encoded symbol to the decoding graph and triggers peeling reduction.
   * Returns true if the symbol provided novel information (useful equation), false if redundant.
   */
  addSymbol(symbol: FecSymbol): boolean {
    if (this.isComplete()) {
      return false; // Block already fully decoded
    }

    if (this.receivedSymbolIds.has(symbol.symbolId)) {
      return false; // Exact duplicate symbolId already processed
    }
    this.receivedSymbolIds.add(symbol.symbolId);

    // Determine neighbors: use metadata if available, otherwise derive deterministically
    let neighbors: readonly number[];
    let symbolData: Uint8Array;

    const ltSym = symbol as Partial<LtEncodedSymbol>;
    if (ltSym.neighbors && ltSym.neighbors.length > 0) {
      neighbors = ltSym.neighbors;
      symbolData = symbol.data;
    } else {
      const derived = deriveSymbolNeighbors(this.k, this.blockIndex, symbol.symbolId);
      neighbors = derived.neighbors;
      symbolData = symbol.data;
    }

    if (symbolData.length !== this.symbolSize) {
      throw new Error(
        `Symbol size mismatch: expected ${this.symbolSize}, received ${symbolData.length}`,
      );
    }

    // Create mutable equation payload copy
    const equationData = new Uint8Array(symbolData);
    const unresolvedNeighbors = new Set<number>();

    // Step 1: XOR out all source symbols that are ALREADY recovered
    for (const neighbor of neighbors) {
      if (neighbor < 0 || neighbor >= this.k) {
        throw new RangeError(`Invalid neighbor index ${neighbor} for block with K=${this.k}`);
      }
      const existing = this.sourceSymbols[neighbor];
      if (existing) {
        // Source symbol already known: cancel it out
        for (let b = 0; b < this.symbolSize; b++) {
          equationData[b] = (equationData[b] ?? 0) ^ (existing[b] ?? 0);
        }
      } else {
        unresolvedNeighbors.add(neighbor);
      }
    }

    // Step 2: Evaluate reduced degree
    if (unresolvedNeighbors.size === 0) {
      // Equation is completely redundant (all neighbors already solved)
      return false;
    }

    const equation: Equation = {
      data: equationData,
      unresolvedNeighbors,
    };

    if (unresolvedNeighbors.size === 1) {
      this.rippleQueue.push(equation);
    } else {
      this.equations.add(equation);
      for (const idx of unresolvedNeighbors) {
        let set = this.sourceToEquations.get(idx);
        if (!set) {
          set = new Set<Equation>();
          this.sourceToEquations.set(idx, set);
        }
        set.add(equation);
      }
    }

    // Step 3: Run peeling ripple propagation
    this.peel();
    return true;
  }

  /**
   * Iteratively peels degree-1 equations from the ripple queue until empty or complete.
   */
  private peel(): void {
    while (this.rippleQueue.length > 0 && !this.isComplete()) {
      const eq = this.rippleQueue.pop()!;
      if (eq.unresolvedNeighbors.size !== 1) {
        continue;
      }

      const sourceIdx = eq.unresolvedNeighbors.values().next().value as number;

      // If already recovered in a concurrent peeling step, skip
      if (this.sourceSymbols[sourceIdx] !== null) {
        continue;
      }

      // Recover source symbol
      this.sourceSymbols[sourceIdx] = eq.data;
      this.recoveredCount++;

      // Propagate recovered symbol to all equations containing it
      const dependents = this.sourceToEquations.get(sourceIdx);
      if (dependents) {
        for (const dep of dependents) {
          if (!this.equations.has(dep)) {
            continue;
          }

          // XOR out newly recovered source symbol
          for (let b = 0; b < this.symbolSize; b++) {
            dep.data[b] = (dep.data[b] ?? 0) ^ (eq.data[b] ?? 0);
          }
          dep.unresolvedNeighbors.delete(sourceIdx);

          if (dep.unresolvedNeighbors.size === 1) {
            this.equations.delete(dep);
            this.rippleQueue.push(dep);
          } else if (dep.unresolvedNeighbors.size === 0) {
            // Degenerate/redundant equation
            this.equations.delete(dep);
          }
        }
        this.sourceToEquations.delete(sourceIdx);
      }
    }
  }

  /**
   * Returns the concatenated reconstructed source block if complete, or null if incomplete.
   */
  reconstruct(): Uint8Array | null {
    if (!this.isComplete()) {
      return null;
    }

    const totalBytes = this.k * this.symbolSize;
    const result = new Uint8Array(totalBytes);
    for (let i = 0; i < this.k; i++) {
      const sym = this.sourceSymbols[i]!;
      result.set(sym, i * this.symbolSize);
    }
    return result;
  }
}

/**
 * Multi-block Luby Transform Fountain Decoder implementing FecDecoder.
 */
export class LtDecoder implements FecDecoder {
  readonly scheme: FecScheme = 'lt-fountain';
  private readonly blockDecoders: Map<number, BlockDecoder> = new Map();

  /**
   * Registers a block with known K and symbolSize.
   */
  registerBlock(blockIndex: number, k: number, symbolSize: number): BlockDecoder {
    let decoder = this.blockDecoders.get(blockIndex);
    if (!decoder) {
      decoder = new BlockDecoder(blockIndex, k, symbolSize);
      this.blockDecoders.set(blockIndex, decoder);
    }
    return decoder;
  }

  addSymbol(symbol: FecSymbol): boolean {
    const ltSym = symbol as Partial<LtEncodedSymbol>;
    const k = ltSym.k;
    const symbolSize = ltSym.symbolSize ?? symbol.data.length;

    let decoder = this.blockDecoders.get(symbol.blockIndex);
    if (!decoder) {
      if (k === undefined) {
        throw new Error(`Cannot create decoder for block ${symbol.blockIndex}: K not specified`);
      }
      decoder = this.registerBlock(symbol.blockIndex, k, symbolSize);
    }

    return decoder.addSymbol(symbol);
  }

  isBlockComplete(blockIndex: number): boolean {
    const decoder = this.blockDecoders.get(blockIndex);
    return decoder ? decoder.isComplete() : false;
  }

  getStatus(blockIndex: number): DecoderStatus {
    const decoder = this.blockDecoders.get(blockIndex);
    return decoder ? decoder.getStatus() : 'incomplete';
  }

  decodeBlock(blockIndex: number): Uint8Array | null {
    const decoder = this.blockDecoders.get(blockIndex);
    return decoder ? decoder.reconstruct() : null;
  }
}

import type { SourceBlock } from '../fec/types.js';
import { Hasher, defaultHasher, computeSha256 } from './hasher.js';
import { bytesToSessionId } from '../packet/binary-codec.js';

export { computeSha256 };

export interface BlockerConfig {
  /** Size of each individual source/encoded symbol in bytes. Default: 256 bytes */
  readonly symbolSize: number;
  /** Number of source symbols per source block (K). Default: 64 symbols */
  readonly symbolsPerBlock: number;
  /** Pluggable SHA-256 Hasher. Default: standard portable hasher */
  readonly hasher?: Hasher;
}

export const DEFAULT_BLOCKER_CONFIG: Required<BlockerConfig> = {
  symbolSize: 256,
  symbolsPerBlock: 64,
  hasher: defaultHasher,
};

export interface FileManifest {
  readonly sessionId: string;
  readonly fileName: string;
  readonly fileSize: number;
  readonly mimeType: string;
  readonly sha256Digest: string;
  readonly symbolSize: number;
  readonly symbolsPerBlock: number;
  readonly totalBlocks: number;
}

/**
 * Generates a standard UUID v4 session ID using available entropy without node:crypto.
 */
export function generateSessionId(): string {
  const bytes = new Uint8Array(16);
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // UUID v4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // Variant 10
  return bytesToSessionId(bytes);
}

/**
 * Splits raw file data into bounded source blocks suitable for FEC encoding.
 * The final symbol of the final block is zero-padded to reach the uniform symbolSize * K boundary.
 * Padding is strictly recorded so it can be discarded upon reassembly.
 */
export class FileBlocker {
  readonly config: Required<BlockerConfig>;

  constructor(config: Partial<BlockerConfig> = {}) {
    this.config = {
      symbolSize: config.symbolSize ?? DEFAULT_BLOCKER_CONFIG.symbolSize,
      symbolsPerBlock: config.symbolsPerBlock ?? DEFAULT_BLOCKER_CONFIG.symbolsPerBlock,
      hasher: config.hasher ?? defaultHasher,
    };

    if (this.config.symbolSize < 1) {
      throw new RangeError(`symbolSize (${this.config.symbolSize}) must be at least 1 byte`);
    }
    if (this.config.symbolsPerBlock < 1) {
      throw new RangeError(`symbolsPerBlock (${this.config.symbolsPerBlock}) must be at least 1`);
    }
  }

  /**
   * Partitions an in-memory buffer into an array of SourceBlocks and creates a FileManifest.
   */
  partition(
    fileBytes: Uint8Array,
    fileName: string = 'file.bin',
    mimeType: string = 'application/octet-stream',
    sessionId?: string,
  ): { manifest: FileManifest; blocks: SourceBlock[] } {
    const finalSessionId = sessionId ?? generateSessionId();
    const fileSize = fileBytes.length;
    const sha256Digest = this.config.hasher.hashSha256(fileBytes);
    const { symbolSize, symbolsPerBlock } = this.config;
    const rawBlockSize = symbolSize * symbolsPerBlock;

    // Handle edge case of empty file (0 bytes)
    if (fileSize === 0) {
      const emptyBlock: SourceBlock = {
        blockIndex: 0,
        totalBlocks: 1,
        symbolSize,
        k: 1,
        data: new Uint8Array(symbolSize), // 1 zeroed symbol
      };
      const manifest: FileManifest = {
        sessionId: finalSessionId,
        fileName,
        fileSize: 0,
        mimeType,
        sha256Digest,
        symbolSize,
        symbolsPerBlock: 1,
        totalBlocks: 1,
      };
      return { manifest, blocks: [emptyBlock] };
    }

    const totalBlocks = Math.ceil(fileSize / rawBlockSize);
    const blocks: SourceBlock[] = new Array<SourceBlock>(totalBlocks);

    for (let b = 0; b < totalBlocks; b++) {
      const start = b * rawBlockSize;
      const end = Math.min(start + rawBlockSize, fileSize);
      const slice = fileBytes.subarray(start, end);

      const k = symbolsPerBlock;
      const paddedSize = k * symbolSize;
      const blockData = new Uint8Array(paddedSize);
      blockData.set(slice, 0); // Copies slice; remainder remains 0 (padding)

      blocks[b] = {
        blockIndex: b,
        totalBlocks,
        symbolSize,
        k,
        data: blockData,
      };
    }

    const manifest: FileManifest = {
      sessionId: finalSessionId,
      fileName,
      fileSize,
      mimeType,
      sha256Digest,
      symbolSize,
      symbolsPerBlock,
      totalBlocks,
    };

    return { manifest, blocks };
  }
}

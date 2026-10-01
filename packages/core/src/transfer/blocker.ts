import { createHash } from 'node:crypto';
import type { SourceBlock } from '../fec/types.js';

export interface BlockerConfig {
  /** Size of each individual source/encoded symbol in bytes. Default: 256 bytes */
  readonly symbolSize: number;
  /** Number of source symbols per source block (K). Default: 64 symbols */
  readonly symbolsPerBlock: number;
}

export const DEFAULT_BLOCKER_CONFIG: BlockerConfig = {
  symbolSize: 256,
  symbolsPerBlock: 64,
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
 * Computes hexadecimal SHA-256 hash using Node's standard crypto module.
 */
export function computeSha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Splits raw file data into bounded source blocks suitable for FEC encoding.
 * The final symbol of the final block is zero-padded to reach the uniform symbolSize * K boundary.
 * Padding is strictly recorded so it can be discarded upon reassembly.
 */
export class FileBlocker {
  readonly config: BlockerConfig;

  constructor(config: Partial<BlockerConfig> = {}) {
    this.config = {
      symbolSize: config.symbolSize ?? DEFAULT_BLOCKER_CONFIG.symbolSize,
      symbolsPerBlock: config.symbolsPerBlock ?? DEFAULT_BLOCKER_CONFIG.symbolsPerBlock,
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
    sessionId: string = crypto.randomUUID(),
  ): { manifest: FileManifest; blocks: SourceBlock[] } {
    const fileSize = fileBytes.length;
    const sha256Digest = computeSha256(fileBytes);
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
        sessionId,
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
      sessionId,
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

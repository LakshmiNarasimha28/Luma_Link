import { FileManifest } from './blocker.js';
import { Hasher, defaultHasher } from './hasher.js';

export class ReassemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReassemblyError';
  }
}

export class IncompleteTransferError extends ReassemblyError {
  readonly missingBlocks: readonly number[];
  constructor(missingBlocks: readonly number[]) {
    super(
      `Cannot reassemble file: missing ${missingBlocks.length} block(s): [${missingBlocks.slice(0, 5).join(', ')}${missingBlocks.length > 5 ? '...' : ''}]`,
    );
    this.name = 'IncompleteTransferError';
    this.missingBlocks = missingBlocks;
  }
}

export class Sha256MismatchError extends ReassemblyError {
  readonly expected: string;
  readonly actual: string;
  constructor(expected: string, actual: string) {
    super(`SHA-256 verification failed!\nExpected: ${expected}\nActual:   ${actual}`);
    this.name = 'Sha256MismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

export interface ReassemblyResult {
  readonly success: boolean;
  readonly fileBytes: Uint8Array;
  readonly verifiedSha256: boolean;
  readonly sha256Digest: string;
}

/**
 * Reassembles decoded source blocks into the verified original user file.
 * Automatically slices off block-level padding and strictly verifies SHA-256 integrity.
 */
export class FileReassembler {
  readonly manifest: FileManifest;
  readonly hasher: Hasher;
  private readonly blocks: Map<number, Uint8Array> = new Map();

  constructor(manifest: FileManifest, hasher: Hasher = defaultHasher) {
    this.manifest = manifest;
    this.hasher = hasher;
  }

  /**
   * Adds a successfully decoded source block.
   */
  addBlock(blockIndex: number, blockData: Uint8Array): void {
    if (blockIndex < 0 || blockIndex >= this.manifest.totalBlocks) {
      throw new RangeError(
        `Invalid block index ${blockIndex}: expected [0, ${this.manifest.totalBlocks - 1}]`,
      );
    }
    this.blocks.set(blockIndex, blockData);
  }

  /**
   * Returns whether all blocks required to assemble the file are available.
   */
  isComplete(): boolean {
    return this.blocks.size === this.manifest.totalBlocks;
  }

  /**
   * Returns list of block indices that are still missing.
   */
  getMissingBlocks(): number[] {
    const missing: number[] = [];
    for (let b = 0; b < this.manifest.totalBlocks; b++) {
      if (!this.blocks.has(b)) {
        missing.push(b);
      }
    }
    return missing;
  }

  /**
   * Assembles all blocks, trims padding, and verifies SHA-256 integrity.
   * Throws IncompleteTransferError if any block is missing.
   * Throws Sha256MismatchError if reconstructed hash does not match manifest.
   */
  reassemble(): ReassemblyResult {
    const missing = this.getMissingBlocks();
    if (missing.length > 0) {
      throw new IncompleteTransferError(missing);
    }

    if (this.manifest.fileSize === 0) {
      const empty = new Uint8Array(0);
      const hash = this.hasher.hashSha256(empty);
      if (hash !== this.manifest.sha256Digest) {
        throw new Sha256MismatchError(this.manifest.sha256Digest, hash);
      }
      return {
        success: true,
        fileBytes: empty,
        verifiedSha256: true,
        sha256Digest: hash,
      };
    }

    // Allocate buffer for the exact unpadded file size
    const assembled = new Uint8Array(this.manifest.fileSize);
    let offset = 0;

    for (let b = 0; b < this.manifest.totalBlocks; b++) {
      const blockBytes = this.blocks.get(b)!;
      const remaining = this.manifest.fileSize - offset;
      const toCopy = Math.min(blockBytes.length, remaining);

      assembled.set(blockBytes.subarray(0, toCopy), offset);
      offset += toCopy;
    }

    // Verify SHA-256
    const actualDigest = this.hasher.hashSha256(assembled);
    if (actualDigest !== this.manifest.sha256Digest) {
      throw new Sha256MismatchError(this.manifest.sha256Digest, actualDigest);
    }

    return {
      success: true,
      fileBytes: assembled,
      verifiedSha256: true,
      sha256Digest: actualDigest,
    };
  }
}

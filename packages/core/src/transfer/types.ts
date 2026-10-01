/**
 * File transfer and preprocessing boundaries for LumaLink.
 */

export interface FileMetadata {
  readonly fileName: string;
  readonly fileSize: number;
  readonly mimeType: string;
  readonly sha256Digest: string;
  readonly totalBlocks: number;
  readonly blockSize: number;
}

export interface TransferProgress {
  readonly bytesProcessed: number;
  readonly totalBytes: number;
  readonly percentComplete: number;
  readonly elapsedMs: number;
  readonly estimatedGoodputBps: number;
}

export interface TransferResult {
  readonly success: boolean;
  readonly fileMetadata: FileMetadata;
  readonly totalDurationMs: number;
  readonly goodputBps: number;
  readonly verifiedSha256: boolean;
  readonly error?: string;
}

export interface FilePreprocessor {
  prepareFile(
    fileBytes: Uint8Array,
    fileName: string,
    mimeType: string,
    blockSize: number,
  ): Promise<FileMetadata>;
}

/**
 * Storage driver abstraction for LumaLink.
 * Decouples file caching and reassembly from Node.js or React Native filesystem primitives.
 */

export interface StorageDriver {
  saveBlock(sessionId: string, blockIndex: number, data: Uint8Array): Promise<void>;
  readBlock(sessionId: string, blockIndex: number): Promise<Uint8Array | null>;
  assembleFile(sessionId: string, totalBlocks: number): Promise<Uint8Array>;
  deleteSessionData(sessionId: string): Promise<void>;
}

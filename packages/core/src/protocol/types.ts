/**
 * Protocol constants and boundary definitions for LumaLink.
 */

export const PROTOCOL_MAGIC = 'LUMA';
export const PROTOCOL_VERSION = 1;

export type TransferMode = 'quick' | 'private';

export interface ProtocolHeader {
  readonly magic: typeof PROTOCOL_MAGIC;
  readonly version: number;
  readonly mode: TransferMode;
  readonly sessionId: string;
}

export interface ProtocolCapabilities {
  readonly maxPacketSizeBytes: number;
  readonly supportedFecSchemes: readonly string[];
  readonly supportedSecurityModes: readonly string[];
}

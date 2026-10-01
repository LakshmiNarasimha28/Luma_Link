/**
 * Transport packet definitions and codec boundaries for LumaLink.
 * Transport packets represent the protocol data units transmitted over the visual channel.
 */

export const PROTOCOL_MAGIC_BYTES = new Uint8Array([0x4c, 0x55, 0x4d, 0x41]); // 'LUMA'
export const CURRENT_PROTOCOL_VERSION = 1;
export const PACKET_HEADER_SIZE = 42;

export enum PacketTypeCode {
  MANIFEST = 1,
  DATA = 2,
  SYNC = 3,
  CONTROL = 4,
}

export type PacketType = 'manifest' | 'data' | 'sync' | 'control';

export interface PacketFecMetadata {
  readonly k: number;
  readonly degree: number;
}

export interface TransportPacket {
  readonly protocolVersion: number;
  readonly packetType: PacketType;
  readonly flags: number;
  readonly sessionId: string;
  readonly blockIndex: number;
  readonly symbolId: number;
  readonly fecMetadata: PacketFecMetadata;
  readonly payload: Uint8Array;
  readonly checksum?: number;
}

export interface PacketCodec {
  encode(packet: TransportPacket): Uint8Array;
  decode(raw: Uint8Array): TransportPacket;
}

export interface PacketValidationResult {
  readonly isValid: boolean;
  readonly packet?: TransportPacket;
  readonly errorMessage?: string;
}

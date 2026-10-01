/**
 * Transport packet definitions and codec boundaries for LumaLink.
 * Transport packets represent the protocol data units transmitted over the visual channel.
 */

export type PacketType = 'manifest' | 'data' | 'sync' | 'control';

export interface TransportPacket {
  readonly protocolVersion: number;
  readonly packetType: PacketType;
  readonly sessionId: string;
  readonly blockIndex: number;
  readonly sequenceNumber: number;
  readonly payload: Uint8Array;
  readonly checksum: number;
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

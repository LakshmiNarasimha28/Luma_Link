import {
  CURRENT_PROTOCOL_VERSION,
  PACKET_HEADER_SIZE,
  PacketType,
  PacketTypeCode,
  TransportPacket,
  PacketCodec,
} from './types.js';

// ============================================================================
// Error Types
// ============================================================================

export class PacketCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PacketCodecError';
  }
}

export class MalformedPacketError extends PacketCodecError {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedPacketError';
  }
}

export class UnsupportedProtocolVersionError extends PacketCodecError {
  readonly version: number;
  constructor(version: number) {
    super(`Unsupported protocol version: ${version} (expected ${CURRENT_PROTOCOL_VERSION})`);
    this.name = 'UnsupportedProtocolVersionError';
    this.version = version;
  }
}

export class InvalidPacketTypeError extends PacketCodecError {
  readonly typeCode: number;
  constructor(typeCode: number) {
    super(`Invalid packet type code: ${typeCode}`);
    this.name = 'InvalidPacketTypeError';
    this.typeCode = typeCode;
  }
}

export class TruncatedPacketError extends PacketCodecError {
  readonly expected: number;
  readonly actual: number;
  constructor(expected: number, actual: number) {
    super(`Truncated packet: expected at least ${expected} bytes, received ${actual}`);
    this.name = 'TruncatedPacketError';
    this.expected = expected;
    this.actual = actual;
  }
}

export class TrailingDataError extends PacketCodecError {
  readonly expected: number;
  readonly actual: number;
  constructor(expected: number, actual: number) {
    super(
      `Trailing data detected: packet length is ${expected} bytes, received buffer of ${actual} bytes`,
    );
    this.name = 'TrailingDataError';
    this.expected = expected;
    this.actual = actual;
  }
}

export class ChecksumMismatchError extends PacketCodecError {
  readonly expected: number;
  readonly actual: number;
  constructor(expected: number, actual: number) {
    super(`Checksum mismatch: expected 0x${expected.toString(16)}, got 0x${actual.toString(16)}`);
    this.name = 'ChecksumMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

// ============================================================================
// CRC-32 (IEEE 802.3)
// ============================================================================

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

export function computeCrc32(data: Uint8Array, previousCrc: number = 0): number {
  let crc = (previousCrc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) {
    crc = (CRC32_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ============================================================================
// Session ID Conversion (16 bytes <-> string)
// ============================================================================

export function sessionIdToBytes(sessionId: string): Uint8Array {
  const bytes = new Uint8Array(16);
  // Strip hyphens if UUID format
  const clean = sessionId.replace(/-/g, '');
  if (/^[0-9a-fA-F]{32}$/.test(clean)) {
    for (let i = 0; i < 16; i++) {
      bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  // Otherwise UTF-8 encode and copy up to 16 bytes
  const encoder = new TextEncoder();
  const encoded = encoder.encode(sessionId);
  bytes.set(encoded.subarray(0, 16));
  return bytes;
}

export function bytesToSessionId(bytes: Uint8Array): string {
  // Try rendering as standard UUID 8-4-4-4-12
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// ============================================================================
// Binary Packet Codec
// ============================================================================

export class BinaryPacketCodec implements PacketCodec {
  /**
   * Encodes a TransportPacket into a deterministic binary buffer.
   *
   * Binary Layout (Big-Endian):
   *   [0..3]   Magic 'LUMA' (0x4c, 0x55, 0x4d, 0x41)
   *   [4]      Protocol Version (uint8)
   *   [5]      Packet Type (uint8)
   *   [6]      Flags (uint8)
   *   [7]      Reserved (uint8)
   *   [8..23]  Session ID (16 bytes)
   *   [24..27] Block Index (uint32)
   *   [28..31] Symbol ID (uint32)
   *   [32..33] Total Source Symbols K (uint16)
   *   [34..35] Degree (uint16)
   *   [36..37] Payload Length (uint16)
   *   [38..41] Checksum (CRC32 over header[0..37] + payload)
   *   [42..]   Payload bytes
   */
  encode(packet: TransportPacket): Uint8Array {
    const payload = packet.payload;
    if (payload.length > 65535) {
      throw new MalformedPacketError(
        `Payload size (${payload.length}) exceeds maximum allowable 65535 bytes`,
      );
    }

    const totalLength = PACKET_HEADER_SIZE + payload.length;
    const buffer = new Uint8Array(totalLength);
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    // 1. Magic 'LUMA'
    buffer[0] = 0x4c;
    buffer[1] = 0x55;
    buffer[2] = 0x4d;
    buffer[3] = 0x41;

    // 2. Version
    view.setUint8(4, packet.protocolVersion);

    // 3. Packet Type
    let typeCode: number;
    switch (packet.packetType) {
      case 'manifest':
        typeCode = PacketTypeCode.MANIFEST;
        break;
      case 'data':
        typeCode = PacketTypeCode.DATA;
        break;
      case 'sync':
        typeCode = PacketTypeCode.SYNC;
        break;
      case 'control':
        typeCode = PacketTypeCode.CONTROL;
        break;
      default:
        throw new MalformedPacketError(`Unknown packet type: ${packet.packetType}`);
    }
    view.setUint8(5, typeCode);

    // 4. Flags & Reserved
    view.setUint8(6, packet.flags & 0xff);
    view.setUint8(7, 0x00);

    // 5. Session ID (16 bytes)
    const sessionBytes = sessionIdToBytes(packet.sessionId);
    buffer.set(sessionBytes, 8);

    // 6. Block & Symbol Identifiers
    view.setUint32(24, packet.blockIndex, false);
    view.setUint32(28, packet.symbolId, false);

    // 7. FEC Metadata
    view.setUint16(32, packet.fecMetadata.k, false);
    view.setUint16(34, packet.fecMetadata.degree, false);

    // 8. Payload Length
    view.setUint16(36, payload.length, false);

    // 9. Payload
    buffer.set(payload, PACKET_HEADER_SIZE);

    // 10. Checksum: CRC32 over header fields [0..37] and payload [42..]
    const headerPrefix = buffer.subarray(0, 38);
    const crc1 = computeCrc32(headerPrefix);
    const checksum = computeCrc32(payload, crc1 ^ 0xffffffff);
    view.setUint32(38, checksum, false);

    return buffer;
  }

  /**
   * Deserializes and strictly validates a raw binary buffer into a TransportPacket.
   */
  decode(raw: Uint8Array, allowTrailing: boolean = false): TransportPacket {
    if (raw.length < PACKET_HEADER_SIZE) {
      throw new TruncatedPacketError(PACKET_HEADER_SIZE, raw.length);
    }

    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

    // 1. Verify Magic
    if (raw[0] !== 0x4c || raw[1] !== 0x55 || raw[2] !== 0x4d || raw[3] !== 0x41) {
      throw new MalformedPacketError('Invalid packet magic header: expected "LUMA"');
    }

    // 2. Verify Protocol Version
    const version = view.getUint8(4);
    if (version !== CURRENT_PROTOCOL_VERSION) {
      throw new UnsupportedProtocolVersionError(version);
    }

    // 3. Verify Packet Type
    const typeCode = view.getUint8(5);
    let packetType: PacketType;
    switch (typeCode) {
      case PacketTypeCode.MANIFEST:
        packetType = 'manifest';
        break;
      case PacketTypeCode.DATA:
        packetType = 'data';
        break;
      case PacketTypeCode.SYNC:
        packetType = 'sync';
        break;
      case PacketTypeCode.CONTROL:
        packetType = 'control';
        break;
      default:
        throw new InvalidPacketTypeError(typeCode);
    }

    const flags = view.getUint8(6);
    // Reserved byte at 7

    // 4. Session ID
    const sessionBytes = raw.subarray(8, 24);
    const sessionId = bytesToSessionId(sessionBytes);

    // 5. Indices & FEC Metadata
    const blockIndex = view.getUint32(24, false);
    const symbolId = view.getUint32(28, false);
    const k = view.getUint16(32, false);
    const degree = view.getUint16(34, false);
    const payloadLength = view.getUint16(36, false);
    const storedChecksum = view.getUint32(38, false);

    // 6. Bounds Validation
    const expectedTotal = PACKET_HEADER_SIZE + payloadLength;
    if (raw.length < expectedTotal) {
      throw new TruncatedPacketError(expectedTotal, raw.length);
    }
    if (!allowTrailing && raw.length > expectedTotal) {
      throw new TrailingDataError(expectedTotal, raw.length);
    }

    // 7. Verify Checksum
    const headerPrefix = raw.subarray(0, 38);
    const payload = raw.subarray(PACKET_HEADER_SIZE, expectedTotal);
    const crc1 = computeCrc32(headerPrefix);
    const computedChecksum = computeCrc32(payload, crc1 ^ 0xffffffff);

    if (computedChecksum !== storedChecksum) {
      throw new ChecksumMismatchError(storedChecksum, computedChecksum);
    }

    return {
      protocolVersion: version,
      packetType,
      flags,
      sessionId,
      blockIndex,
      symbolId,
      fecMetadata: { k, degree },
      payload: new Uint8Array(payload), // defensive copy
      checksum: storedChecksum,
    };
  }
}

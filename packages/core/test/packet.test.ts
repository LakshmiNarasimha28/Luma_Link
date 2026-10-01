import { describe, it, expect } from 'vitest';
import {
  BinaryPacketCodec,
  MalformedPacketError,
  TruncatedPacketError,
  UnsupportedProtocolVersionError,
  InvalidPacketTypeError,
  ChecksumMismatchError,
  TrailingDataError,
} from '../src/packet/binary-codec.js';
import type { TransportPacket } from '../src/packet/types.js';

describe('Binary Packet Codec', () => {
  const codec = new BinaryPacketCodec();

  const samplePacket: TransportPacket = {
    protocolVersion: 1,
    packetType: 'data',
    flags: 0x01,
    sessionId: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
    blockIndex: 42,
    symbolId: 108,
    fecMetadata: {
      k: 64,
      degree: 3,
    },
    payload: new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]),
  };

  it('performs deterministic round-trip serialization and deserialization', () => {
    const serialized = codec.encode(samplePacket);
    expect(serialized).toBeInstanceOf(Uint8Array);

    const deserialized = codec.decode(serialized);

    expect(deserialized.protocolVersion).toBe(samplePacket.protocolVersion);
    expect(deserialized.packetType).toBe(samplePacket.packetType);
    expect(deserialized.flags).toBe(samplePacket.flags);
    expect(deserialized.sessionId).toBe(samplePacket.sessionId);
    expect(deserialized.blockIndex).toBe(samplePacket.blockIndex);
    expect(deserialized.symbolId).toBe(samplePacket.symbolId);
    expect(deserialized.fecMetadata).toEqual(samplePacket.fecMetadata);
    expect(deserialized.payload).toEqual(samplePacket.payload);
    expect(typeof deserialized.checksum).toBe('number');
  });

  it('rejects packets with invalid magic header', () => {
    const serialized = codec.encode(samplePacket);
    serialized[0] = 0x58; // Corrupt 'L' -> 'X'

    expect(() => codec.decode(serialized)).toThrow(MalformedPacketError);
  });

  it('rejects packets with unsupported protocol version', () => {
    const serialized = codec.encode(samplePacket);
    serialized[4] = 99; // Version 99

    expect(() => codec.decode(serialized)).toThrow(UnsupportedProtocolVersionError);
  });

  it('rejects invalid packet type codes', () => {
    const serialized = codec.encode(samplePacket);
    serialized[5] = 250; // Undefined type code

    expect(() => codec.decode(serialized)).toThrow(InvalidPacketTypeError);
  });

  it('rejects truncated packets shorter than header size', () => {
    const truncated = new Uint8Array(20);
    truncated.set([0x4c, 0x55, 0x4d, 0x41]);

    expect(() => codec.decode(truncated)).toThrow(TruncatedPacketError);
  });

  it('rejects truncated payload bytes', () => {
    const serialized = codec.encode(samplePacket);
    const cut = serialized.subarray(0, serialized.length - 2);

    expect(() => codec.decode(cut)).toThrow(TruncatedPacketError);
  });

  it('rejects packets with trailing data when allowTrailing is false', () => {
    const serialized = codec.encode(samplePacket);
    const withTrailing = new Uint8Array(serialized.length + 4);
    withTrailing.set(serialized, 0);
    withTrailing.set([0xff, 0xff, 0xff, 0xff], serialized.length);

    expect(() => codec.decode(withTrailing)).toThrow(TrailingDataError);
  });

  it('detects corrupted payload via checksum verification', () => {
    const serialized = codec.encode(samplePacket);
    // Flip a byte in payload
    serialized[serialized.length - 1]! ^= 0x01;

    expect(() => codec.decode(serialized)).toThrow(ChecksumMismatchError);
  });
});

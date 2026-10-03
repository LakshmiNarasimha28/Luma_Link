import { describe, it, expect } from 'vitest';
import {
  QrVisualCodec,
  VisualPacketCodec,
  VisualCapacityError,
  VisualDecodeError,
  applySaltAndPepperNoise,
  applyPartialObstruction,
  type TransportPacket,
} from '../src/index.js';
import { NodeCryptoProvider } from '../src/platform/node/index.js';

describe('Phase 3 Visual Codec — QR Baseline', () => {
  const codec = new QrVisualCodec();
  const packetAdapter = new VisualPacketCodec(codec);
  const crypto = new NodeCryptoProvider();

  describe('1. Binary Payload Handling & Round-Trip Fidelity', () => {
    it('handles empty payload (0 bytes) round-trip', () => {
      const empty = new Uint8Array(0);
      const frame = codec.encode(empty);
      expect(frame.metadata.payloadBytes).toBe(0);
      expect(frame.metadata.version).toBeGreaterThanOrEqual(1);

      const decoded = codec.decode(frame);
      expect(decoded.length).toBe(0);
      expect(decoded).toEqual(empty);
    });

    it('handles one-byte payload round-trip', () => {
      const oneByte = new Uint8Array([0x42]);
      const frame = codec.encode(oneByte);
      const decoded = codec.decode(frame);

      expect(decoded.length).toBe(1);
      expect(decoded[0]).toBe(0x42);
    });

    it('handles all-zero binary data round-trip', () => {
      const allZeros = new Uint8Array(128).fill(0x00);
      const frame = codec.encode(allZeros);
      const decoded = codec.decode(frame);

      expect(decoded).toEqual(allZeros);
    });

    it('handles all-0xFF binary data round-trip', () => {
      const allOnes = new Uint8Array(128).fill(0xff);
      const frame = codec.encode(allOnes);
      const decoded = codec.decode(frame);

      expect(decoded).toEqual(allOnes);
    });

    it('preserves arbitrary random binary data without modification or text mangling', () => {
      const randomData = crypto.randomBytes(256);
      const frame = codec.encode(randomData, { eccLevel: 'M' });
      const decoded = codec.decode(frame);

      expect(decoded.length).toBe(256);
      expect(decoded).toEqual(randomData);
    });
  });

  describe('2. QR Versions & Error Correction Levels', () => {
    it('supports all 4 standard ECC levels (L, M, Q, H)', () => {
      const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const levels: Array<'L' | 'M' | 'Q' | 'H'> = ['L', 'M', 'Q', 'H'];

      for (const ecc of levels) {
        const frame = codec.encode(payload, { eccLevel: ecc });
        expect(frame.metadata.eccLevel).toBe(ecc);
        const decoded = codec.decode(frame);
        expect(decoded).toEqual(payload);
      }
    });

    it('automatically scales QR version with increasing payload size', () => {
      const small = crypto.randomBytes(16);
      const medium = crypto.randomBytes(100);
      const large = crypto.randomBytes(350);

      const frameSmall = codec.encode(small);
      const frameMedium = codec.encode(medium);
      const frameLarge = codec.encode(large);

      expect(frameSmall.metadata.version).toBeLessThan(frameMedium.metadata.version);
      expect(frameMedium.metadata.version).toBeLessThan(frameLarge.metadata.version);

      expect(codec.decode(frameSmall)).toEqual(small);
      expect(codec.decode(frameMedium)).toEqual(medium);
      expect(codec.decode(frameLarge)).toEqual(large);
    });

    it('supports forced explicit QR version when payload fits', () => {
      const payload = crypto.randomBytes(20);
      // Version 4 M capacity is 62 bytes
      const frame = codec.encode(payload, { version: 4, eccLevel: 'M' });
      expect(frame.metadata.version).toBe(4);
      expect(codec.decode(frame)).toEqual(payload);
    });
  });

  describe('3. Capacity Validation & Boundary Conditions', () => {
    it('correctly reports theoretical ISO/IEC 18004 capacities', () => {
      expect(codec.getCapacity(1, 'L')).toBe(17);
      expect(codec.getCapacity(1, 'H')).toBe(7);
      expect(codec.getCapacity(10, 'M')).toBe(213);
      expect(codec.getCapacity(40, 'L')).toBe(2953);
    });

    it('successfully encodes payload near capacity of Version 1', () => {
      // Version 1 Level M capacity = 14 bytes
      const payload14 = crypto.randomBytes(14);
      const frame = codec.encode(payload14, { version: 1, eccLevel: 'M' });
      expect(frame.metadata.version).toBe(1);
      expect(codec.decode(frame)).toEqual(payload14);
    });

    it('throws VisualCapacityError when payload exceeds specified version capacity', () => {
      // 15 bytes exceeds Version 1 Level M (14 bytes)
      const payload15 = crypto.randomBytes(15);
      expect(() => codec.encode(payload15, { version: 1, eccLevel: 'M' })).toThrow(
        VisualCapacityError,
      );
    });

    it('throws VisualCapacityError when payload exceeds maximum QR version 40 capacity', () => {
      const hugePayload = new Uint8Array(3500); // Exceeds max QR byte capacity (2953)
      expect(() => codec.encode(hugePayload)).toThrow(VisualCapacityError);
    });
  });

  describe('4. Failure Handling & Invalid Input', () => {
    it('throws VisualDecodeError on completely blank white image', () => {
      const blankPixelBuffer = {
        width: 100,
        height: 100,
        data: new Uint8ClampedArray(100 * 100 * 4).fill(255),
      };
      expect(() => codec.decode(blankPixelBuffer)).toThrow(VisualDecodeError);
    });

    it('throws VisualDecodeError on pure random noise image', () => {
      const noise = crypto.randomBytes(100 * 100 * 4);
      const noisePixelBuffer = {
        width: 100,
        height: 100,
        data: new Uint8ClampedArray(noise.buffer),
      };
      expect(() => codec.decode(noisePixelBuffer)).toThrow(VisualDecodeError);
    });
  });

  describe('5. Synthetic Degradation & Error-Correction Resilience', () => {
    it('tolerates minor salt-and-pepper noise under Level M', () => {
      const payload = crypto.randomBytes(64);
      const frame = codec.encode(payload, { eccLevel: 'M', scale: 4 });

      // Apply 1% synthetic salt-and-pepper pixel noise
      const noisyPixels = applySaltAndPepperNoise(frame.pixelBuffer, 0.01, 777);
      const recovered = codec.decode(noisyPixels);

      expect(recovered).toEqual(payload);
    });

    it('proves Level H tolerates higher obstruction than Level L', () => {
      const payload = crypto.randomBytes(32);

      // Encode under Level L (~7% ECC) and Level H (~30% ECC)
      const frameL = codec.encode(payload, { eccLevel: 'L', scale: 5 });
      const frameH = codec.encode(payload, { eccLevel: 'H', scale: 5 });

      // Apply a rectangular partial obstruction in the data area (center-right, away from finders)
      const obstructedL = applyPartialObstruction(frameL.pixelBuffer, 0.45, 0.45, 0.28, 0.28);
      const obstructedH = applyPartialObstruction(frameH.pixelBuffer, 0.45, 0.45, 0.28, 0.28);

      // Level H survives the 28% data region obstruction
      const recoveredH = codec.decode(obstructedH);
      expect(recoveredH).toEqual(payload);

      // Level L fails the obstruction beyond its ~7% ECC budget
      expect(() => codec.decode(obstructedL)).toThrow(VisualDecodeError);
    });
  });

  describe('6. Transport Packet Adapter (Strategy A: 1 Packet → 1 Frame)', () => {
    it('encodes and decodes a Phase 1 TransportPacket without data loss', () => {
      const packet: TransportPacket = {
        protocolVersion: 1,
        packetType: 'data',
        flags: 0,
        sessionId: '01020304-0506-0708-090a-0b0c0d0e0f10',
        blockIndex: 3,
        symbolId: 42,
        fecMetadata: { k: 16, degree: 2 },
        payload: new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]),
      };

      const frame = packetAdapter.encodePacket(packet, { eccLevel: 'M' });
      expect(frame.metadata.payloadBytes).toBeGreaterThan(packet.payload.length); // includes 42B header

      const recoveredPacket = packetAdapter.decodePacket(frame);

      expect(recoveredPacket.protocolVersion).toBe(packet.protocolVersion);
      expect(recoveredPacket.packetType).toBe(packet.packetType);
      expect(recoveredPacket.sessionId).toBe(packet.sessionId);
      expect(recoveredPacket.blockIndex).toBe(packet.blockIndex);
      expect(recoveredPacket.symbolId).toBe(packet.symbolId);
      expect(recoveredPacket.fecMetadata).toEqual(packet.fecMetadata);
      expect(recoveredPacket.payload).toEqual(packet.payload);
    });

    it('encodes and decodes an AEAD-encrypted TransportPacket with Poly1305 tag', () => {
      const encryptedWirePayload = new Uint8Array(16 + 64); // 16B tag + 64B ciphertext
      for (let i = 0; i < encryptedWirePayload.length; i++) {
        encryptedWirePayload[i] = (i * 13) & 0xff;
      }

      const encryptedPacket: TransportPacket = {
        protocolVersion: 1,
        packetType: 'data',
        flags: 0x02, // FLAG_ENCRYPTED
        sessionId: 'aabbccdd-eeff-1122-3344-556677889900',
        blockIndex: 0,
        symbolId: 99,
        fecMetadata: { k: 32, degree: 1 },
        payload: encryptedWirePayload,
      };

      const frame = packetAdapter.encodePacket(encryptedPacket);
      const recovered = packetAdapter.decodePacket(frame);

      expect(recovered.flags).toBe(0x02);
      expect(recovered.payload).toEqual(encryptedWirePayload);
    });
  });

  describe('7. Multi-Packet Packing Adapter (Strategy B: N Packets → 1 Frame)', () => {
    it('bundles multiple TransportPackets into a single visual frame and extracts them', () => {
      const packets: TransportPacket[] = [
        {
          protocolVersion: 1,
          packetType: 'data',
          flags: 0,
          sessionId: '11111111-2222-3333-4444-555555555555',
          blockIndex: 0,
          symbolId: 1,
          fecMetadata: { k: 8, degree: 1 },
          payload: new Uint8Array([1, 2, 3, 4]),
        },
        {
          protocolVersion: 1,
          packetType: 'data',
          flags: 0,
          sessionId: '11111111-2222-3333-4444-555555555555',
          blockIndex: 0,
          symbolId: 2,
          fecMetadata: { k: 8, degree: 2 },
          payload: new Uint8Array([5, 6, 7, 8, 9, 10]),
        },
        {
          protocolVersion: 1,
          packetType: 'control',
          flags: 0,
          sessionId: '11111111-2222-3333-4444-555555555555',
          blockIndex: 0,
          symbolId: 3,
          fecMetadata: { k: 8, degree: 1 },
          payload: new Uint8Array([99]),
        },
      ];

      const multiFrame = packetAdapter.encodePackets(packets, { eccLevel: 'M' });
      const decodedPackets = packetAdapter.decodePackets(multiFrame);

      expect(decodedPackets.length).toBe(3);
      for (let i = 0; i < 3; i++) {
        expect(decodedPackets[i]!.blockIndex).toBe(packets[i]!.blockIndex);
        expect(decodedPackets[i]!.symbolId).toBe(packets[i]!.symbolId);
        expect(decodedPackets[i]!.packetType).toBe(packets[i]!.packetType);
        expect(decodedPackets[i]!.payload).toEqual(packets[i]!.payload);
      }
    });
  });
});

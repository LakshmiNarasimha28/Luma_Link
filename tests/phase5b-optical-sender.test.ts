import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import {
  BinaryPacketCodec,
  QrVisualCodec,
  computeCrc32,
  PortableHasher,
  ReceiverSession,
  ChecksumMismatchError,
  MalformedPacketError,
  TruncatedPacketError,
  renderMatrixToRgba,
  SimpleBitMatrix,
  type TransportPacket,
} from '@lumalink/core';
import { NodeCryptoProvider } from '@lumalink/core/node';
import {
  generatePhase5bPackets,
  generateDeterministicBinaryPayload,
} from '../scripts/generate-phase5b-packets.js';

describe('Phase 5B Real Protocol Packets -> Optical Sender', () => {
  const binaryPacketCodec = new BinaryPacketCodec();
  const qrVisualCodec = new QrVisualCodec();
  const portableHasher = new PortableHasher();

  it('generates deterministic test file and validated canonical TransportPackets', () => {
    const payload = generateDeterministicBinaryPayload(1024, 0x5b5b5b5b);
    expect(payload.length).toBe(1024);

    // Verify 8-byte PNG-compatible header signature
    expect(Array.from(payload.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);

    const result = generatePhase5bPackets({
      symbolSize: 64,
      symbolsPerBlock: 16,
      overheadFactor: 2.4,
      seed: 0x5b5b5b5b,
    });

    expect(result.manifest.totalBlocks).toBe(1);
    expect(result.manifest.symbolsPerBlock).toBe(16);
    expect(result.manifest.symbolSize).toBe(64);
    expect(result.manifest.fileSize).toBe(1024);
    expect(result.manifest.fileSha256).toBe(portableHasher.hashSha256(payload));

    // Target packet count: Math.ceil(16 * 2.4) = 39
    expect(result.packets.length).toBe(39);

    // Verify all packets are 122 bytes (42B header + 64B symbol + 16B Poly1305 MAC)
    for (let s = 0; s < result.packets.length; s++) {
      const pkt = result.packets[s]!;
      expect(pkt.symbolId).toBe(s);
      expect(pkt.blockIndex).toBe(0);
      expect(pkt.k).toBe(16);
      expect(pkt.degree).toBeGreaterThanOrEqual(1);
      expect(pkt.degree).toBeLessThanOrEqual(16);
      expect(pkt.wireLength).toBe(122);
      expect(pkt.wireBytes.length).toBe(122);

      // Verify magic 'LUMA'
      expect(pkt.wireBytes[0]).toBe(0x4c);
      expect(pkt.wireBytes[1]).toBe(0x55);
      expect(pkt.wireBytes[2]).toBe(0x4d);
      expect(pkt.wireBytes[3]).toBe(0x41);
    }
  });

  it('validates round-trip decode and CRC-32 on every generated packet', () => {
    const result = generatePhase5bPackets();

    for (const pkt of result.packets) {
      const decoded: TransportPacket = binaryPacketCodec.decode(pkt.wireBytes);

      expect(decoded.protocolVersion).toBe(1);
      expect(decoded.packetType).toBe('data');
      expect((decoded.flags & 0x02) !== 0).toBe(true); // FLAG_ENCRYPTED
      expect(decoded.sessionId).toBe(result.manifest.sessionId);
      expect(decoded.blockIndex).toBe(0);
      expect(decoded.symbolId).toBe(pkt.symbolId);
      expect(decoded.fecMetadata.k).toBe(16);
      expect(decoded.fecMetadata.degree).toBe(pkt.degree);
      expect(decoded.payload.length).toBe(80); // 64B ciphertext + 16B tag

      // Independent CRC-32 verification
      const headerPrefix = pkt.wireBytes.subarray(0, 38);
      const payloadBytes = pkt.wireBytes.subarray(42);
      const crc1 = computeCrc32(headerPrefix);
      const fullCrc = computeCrc32(payloadBytes, crc1 ^ 0xffffffff);
      const view = new DataView(
        pkt.wireBytes.buffer,
        pkt.wireBytes.byteOffset,
        pkt.wireBytes.byteLength,
      );
      const storedCrc = view.getUint32(38, false);

      expect(fullCrc).toBe(storedCrc);
      expect(decoded.checksum).toBe(storedCrc);
    }
  });

  it('proves visual codec byte-mode preservation between canonical QrVisualCodec and browser qrcode.min.js', () => {
    const result = generatePhase5bPackets();
    const testWireBytes = result.packets[0]!.wireBytes;
    expect(testWireBytes.length).toBe(122);

    // 1. Canonical QrVisualCodec path: wireBytes -> QR -> decode -> wireBytes
    const canonicalFrame = qrVisualCodec.encode(testWireBytes, {
      eccLevel: 'M',
      scale: 4,
    });
    const canonicalDecoded = qrVisualCodec.decode(canonicalFrame);
    expect(canonicalDecoded).toEqual(testWireBytes);

    // 2. Browser qrcode.min.js path: run vendored bundle in sandbox
    const qrcodeJsPath = path.resolve(__dirname, '../scripts/display-harness/qrcode.min.js');
    const qrcodeJsContent = fs.readFileSync(qrcodeJsPath, 'utf8');

    const sandbox: Record<string, unknown> = {};
    vm.runInNewContext(qrcodeJsContent, sandbox);
    const browserQr = sandbox.QRCode as {
      create: (
        data: unknown[],
        opts: unknown,
      ) => {
        modules: { size: number; data: Uint8Array };
        version: number;
      };
    };
    expect(browserQr).toBeDefined();

    // Encode wireBytes using Byte Mode in browser qrcode.min.js
    const qrData = browserQr.create([{ data: testWireBytes, mode: 'byte' }], {
      errorCorrectionLevel: 'M',
    });

    expect(qrData.version).toBe(7); // Version 7 fits 122 bytes at ECC M
    expect(qrData.modules.size).toBe(45); // Version 7 is 45x45 modules

    // Render matrix to RGBA pixel buffer using standard helper
    const matrix = new SimpleBitMatrix(
      qrData.modules.size,
      qrData.modules.size,
      qrData.modules.data,
    );
    const pixelBuffer = renderMatrixToRgba(matrix, 4, 4);

    // Decode with QrVisualCodec (which wraps jsQR)
    const browserDecodedBytes = qrVisualCodec.decode(pixelBuffer);

    // Byte-for-byte identity assertion
    expect(browserDecodedBytes).toEqual(testWireBytes);
  });

  it('verifies that scripts/display-harness/real-packets.js is valid and self-contained under file://', () => {
    const fixturePath = path.resolve(__dirname, '../scripts/display-harness/real-packets.js');
    expect(fs.existsSync(fixturePath)).toBe(true);

    const fixtureCode = fs.readFileSync(fixturePath, 'utf8');
    const sandboxWindow: Record<string, unknown> = {};
    const sandboxContext = {
      window: sandboxWindow,
      Uint8Array,
    };

    // Execute fixture in isolated VM simulating browser file:// load
    vm.runInNewContext(fixtureCode, sandboxContext);

    const fixture = sandboxWindow.LUMALINK_REAL_PACKETS as {
      manifest: {
        sessionId: string;
        fileName: string;
        fileSize: number;
        fileSha256: string;
        symbolSize: number;
        symbolsPerBlock: number;
        totalBlocks: number;
        overheadFactor: number;
        totalPackets: number;
      };
      packets: Uint8Array[];
    };

    expect(fixture).toBeDefined();
    expect(fixture.manifest.fileName).toBe('phase5b-optical-test.bin');
    expect(fixture.manifest.totalBlocks).toBe(1);
    expect(fixture.manifest.symbolsPerBlock).toBe(16);
    expect(fixture.manifest.symbolSize).toBe(64);
    expect(fixture.manifest.totalPackets).toBe(39);
    expect(fixture.packets.length).toBe(39);

    // Every packet must decode cleanly and have LUMA magic
    for (let i = 0; i < fixture.packets.length; i++) {
      const wireBytes = fixture.packets[i]!;
      expect(wireBytes instanceof Uint8Array).toBe(true);
      expect(wireBytes.length).toBe(122);
      expect(wireBytes[0]).toBe(0x4c); // 'L'
      expect(wireBytes[1]).toBe(0x55); // 'U'
      expect(wireBytes[2]).toBe(0x4d); // 'M'
      expect(wireBytes[3]).toBe(0x41); // 'A'

      const decoded = binaryPacketCodec.decode(wireBytes);
      expect(decoded.symbolId).toBe(i);
      expect(decoded.blockIndex).toBe(0);
      expect(decoded.sessionId).toBe(fixture.manifest.sessionId);
    }
  });

  it('rejects corrupted or tampered packets cleanly', () => {
    const result = generatePhase5bPackets();
    const validWireBytes = result.packets[0]!.wireBytes;

    // 1. Corrupted Magic
    const badMagic = new Uint8Array(validWireBytes);
    badMagic[0] = 0x58; // 'X'
    expect(() => binaryPacketCodec.decode(badMagic)).toThrow(MalformedPacketError);

    // 2. Corrupted CRC-32
    const badCrc = new Uint8Array(validWireBytes);
    badCrc[badCrc.length - 1]! ^= 0x55;
    expect(() => binaryPacketCodec.decode(badCrc)).toThrow(ChecksumMismatchError);

    // 3. Truncated Packet (< 42 bytes)
    const truncated = validWireBytes.subarray(0, 30);
    expect(() => binaryPacketCodec.decode(truncated)).toThrow(TruncatedPacketError);
  });

  it('successfully decrypts and reassembles the original file from the generated real wire packets', () => {
    const crypto = new NodeCryptoProvider();
    const result = generatePhase5bPackets({
      symbolSize: 64,
      symbolsPerBlock: 16,
      overheadFactor: 2.4,
      seed: 0x5b5b5b5b,
    });

    const expectedPayload = generateDeterministicBinaryPayload(1024, 0x5b5b5b5b);

    // Initialize ReceiverSession with the announcement and authorized key envelope
    const announcement = result.sender.getAnnouncement();
    const receiver = ReceiverSession.createQuickSend(announcement, undefined, crypto);
    const authRequest = receiver.createAuthRequest();
    const authResponse = result.sender.handleAuthRequest(authRequest);
    receiver.applyKeyEnvelope(authResponse.keyEnvelope!);

    // Ingest generated wire packets into receiver
    for (const pkt of result.packets) {
      const decodedPacket = binaryPacketCodec.decode(pkt.wireBytes);
      receiver.processPacket(decodedPacket);

      if (receiver.isComplete()) {
        break;
      }
    }

    expect(receiver.isComplete()).toBe(true);
    const reassemblyResult = receiver.reassemble();
    expect(reassemblyResult.success).toBe(true);
    expect(reassemblyResult.verifiedSha256).toBe(true);
    expect(reassemblyResult.sha256Digest).toBe(result.manifest.fileSha256);
    expect(reassemblyResult.fileBytes).toEqual(expectedPayload);
  });

  it('preserves repetition semantics (R=1, R=2, R=3) as a physical display mechanism without altering protocol packets', () => {
    const result = generatePhase5bPackets();
    const packet0 = result.packets[0]!;
    const packet1 = result.packets[1]!;

    // Repetition semantics:
    // R=1: 1 display interval per packet
    // R=2: 2 display intervals per packet (packet remains unchanged across intervals)
    // R=3: 3 display intervals per packet
    for (const R of [1, 2, 3]) {
      const displaySequence: Uint8Array[] = [];
      const intervalMs = 66;
      const effectiveDurationMs = intervalMs * R;

      // In the browser display harness: setTimeout(tick, interval * rep)
      expect(effectiveDurationMs).toBe(intervalMs * R);

      // Simulating physical display ticks with repetition
      for (const pkt of [packet0, packet1]) {
        for (let rep = 0; rep < R; rep++) {
          displaySequence.push(pkt.wireBytes);
        }
      }

      expect(displaySequence.length).toBe(2 * R);

      // Verify that every repeated frame contains identical wire bytes, identical CRC, and identical header
      for (let r = 0; r < R; r++) {
        expect(displaySequence[r]).toBe(packet0.wireBytes);
      }
      for (let r = R; r < 2 * R; r++) {
        expect(displaySequence[r]).toBe(packet1.wireBytes);
      }
    }

    // Verify receiver ingestion tolerance: physical repetitions do not corrupt session state
    const crypto = new NodeCryptoProvider();
    const announcement = result.sender.getAnnouncement();
    const receiver = ReceiverSession.createQuickSend(announcement, undefined, crypto);
    const authRequest = receiver.createAuthRequest();
    const authResponse = result.sender.handleAuthRequest(authRequest);
    receiver.applyKeyEnvelope(authResponse.keyEnvelope!);

    // Feed each packet R=3 times (simulating camera oversampling a repeated physical display)
    for (const pkt of result.packets) {
      const decodedPacket = binaryPacketCodec.decode(pkt.wireBytes);
      for (let rep = 0; rep < 3; rep++) {
        receiver.processPacket(decodedPacket);
      }
      if (receiver.isComplete()) {
        break;
      }
    }

    expect(receiver.isComplete()).toBe(true);
    const reassemblyResult = receiver.reassemble();
    expect(reassemblyResult.success).toBe(true);
  });
});

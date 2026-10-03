import { describe, it, expect } from 'vitest';
import {
  FileBlocker,
  FileReassembler,
  SenderSession,
  ReceiverSession,
  computeSha256,
  PortableHasher,
  BinaryPacketCodec,
  QrVisualCodec,
  VisualPacketCodec,
  Sha256MismatchError,
  type TransportPacket,
  type VisualFrame,
} from '@lumalink/core';
import { NodeCryptoProvider, NodeHasher } from '@lumalink/core/node';

describe('Phase 5A End-to-End Real Binary File Optical Transfer', () => {
  const crypto = new NodeCryptoProvider();
  const portableHasher = new PortableHasher();
  const nodeHasher = new NodeHasher();
  const visualCodec = new QrVisualCodec();
  const packetVisualAdapter = new VisualPacketCodec(visualCodec);
  const binaryPacketCodec = new BinaryPacketCodec();

  const symbolSize = 128;
  const symbolsPerBlock = 16; // 2,048 bytes per block
  const fileSize = 8192; // 8,192 bytes = 4 complete source blocks (>= 8 KB binary payload)

  /**
   * Generates a realistic structured binary payload (PNG-like file header,
   * chunk structures, chunk CRCs, and pseudo-random compressed-like data bytes).
   */
  function generateRealBinaryPayload(size: number): Uint8Array {
    const payload = new Uint8Array(size);

    // PNG-compatible magic signature: 0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'
    payload.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);

    // IHDR chunk: length (13), chunk type 'IHDR'
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    view.setUint32(8, 13, false); // Length
    payload.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
    view.setUint32(16, 256, false); // Width: 256
    view.setUint32(20, 256, false); // Height: 256
    payload[24] = 8; // Bit depth: 8
    payload[25] = 6; // Color type: RGBA (6)
    payload[26] = 0; // Compression
    payload[27] = 0; // Filter
    payload[28] = 0; // Interlace
    view.setUint32(29, 0x5776ba73, false); // CRC for IHDR

    // High-entropy pseudo-random binary data filling remaining payload
    let state = 0x85ebca6b >>> 0;
    for (let i = 33; i < size - 12; i++) {
      state = (Math.imul(state ^ (state >>> 16), 0x45d9f3b) + 0x12345) >>> 0;
      payload[i] = (state >>> 24) & 0xff;
    }

    // IEND chunk at end
    const iendOffset = size - 12;
    view.setUint32(iendOffset, 0, false); // Length 0
    payload.set([0x49, 0x45, 0x4e, 0x44], iendOffset + 4); // 'IEND'
    view.setUint32(iendOffset + 8, 0xae426082, false); // CRC for IEND

    return payload;
  }

  it('transfers an 8 KB real binary file through the full optical pipeline with loss, duplication, and reordering', () => {
    // 1. Generate real binary file (8,192 bytes)
    const originalFile = generateRealBinaryPayload(fileSize);
    expect(originalFile.length).toBe(fileSize);

    // Cross-check SHA-256 between PortableHasher and NodeHasher
    const originalSha256 = portableHasher.hashSha256(originalFile);
    const nodeSha256 = nodeHasher.hashSha256(originalFile);
    expect(originalSha256).toBe(nodeSha256);
    expect(computeSha256(originalFile)).toBe(originalSha256);

    // 2. Partition file into blocks using FileBlocker
    const blocker = new FileBlocker({ symbolSize, symbolsPerBlock, hasher: portableHasher });
    const { manifest, blocks } = blocker.partition(originalFile, 'real-image.png', 'image/png');

    expect(manifest.fileSize).toBe(fileSize);
    expect(manifest.totalBlocks).toBe(4);
    expect(manifest.sha256Digest).toBe(originalSha256);
    expect(blocks.length).toBe(4);

    // 3. Sender and Receiver Sessions with X25519 and ChaCha20-Poly1305 key agreement
    const senderIdentity = {
      deviceId: 'sender-station-alpha',
      keyPair: crypto.generateKeyPair(),
    };
    const sender = new SenderSession(manifest, blocks, 'quick', senderIdentity, crypto);
    const announcement = sender.getAnnouncement();

    const receiver = ReceiverSession.createQuickSend(announcement, undefined, crypto);
    const authRequest = receiver.createAuthRequest();
    const authResponse = sender.handleAuthRequest(authRequest);
    receiver.applyKeyEnvelope(authResponse.keyEnvelope!);

    // 4. Generate encrypted fountain packets for each block
    // Overhead 2.4x: 16 source symbols * 2.4 ≈ 39 symbols per block (156 total symbols)
    const fountainOverhead = 2.4;
    const generatedPackets: TransportPacket[] = [];

    for (const block of blocks) {
      const symbolsToSend = Math.ceil(block.k * fountainOverhead);
      for (let s = 0; s < symbolsToSend; s++) {
        const encryptedPacket = sender.generateEncryptedPacket(block.blockIndex, s);
        generatedPackets.push(encryptedPacket);
      }
    }
    expect(generatedPackets.length).toBeGreaterThanOrEqual(150);

    // 5. Convert TransportPackets to VisualFrames (QR codes)
    const visualFrames: VisualFrame[] = [];
    for (const pkt of generatedPackets) {
      const frame = packetVisualAdapter.encodePacket(pkt, {
        eccLevel: 'M',
        scale: 3,
      });
      visualFrames.push(frame);
    }
    expect(visualFrames.length).toBe(generatedPackets.length);

    // 6. Simulate Channel Impairments:
    // (Loss/duplication/reordering parameters are experimental test configurations, not general guarantees)
    // - Loss: 15% random drop rate
    // - Duplication: 10% duplicate frames (simulating camera oversampling)
    // - Reordering: sliding-window shuffle
    const simulatedChannelFrames: VisualFrame[] = [];
    let prng = 0x12345678 >>> 0;
    function nextRand(): number {
      prng = (Math.imul(prng, 1664525) + 1013904223) >>> 0;
      return (prng >>> 0) / 0xffffffff;
    }

    for (const frame of visualFrames) {
      // 15% packet loss
      if (nextRand() < 0.15) {
        continue; // Dropped by optical channel
      }

      simulatedChannelFrames.push(frame);

      // 10% packet duplication (oversampled by receiver camera)
      if (nextRand() < 0.1) {
        simulatedChannelFrames.push(frame);
      }
    }

    // Sliding-window jitter / reordering (window size 5)
    for (let i = 0; i < simulatedChannelFrames.length - 4; i += 4) {
      // Swap adjacent frames within local window
      const tmp = simulatedChannelFrames[i]!;
      simulatedChannelFrames[i] = simulatedChannelFrames[i + 2]!;
      simulatedChannelFrames[i + 2] = tmp;
    }

    // 7. Receiver Pipeline: Visual QR Decode -> AEAD Decryption -> LT Peeling Reassembly
    let framesProcessed = 0;
    for (const frame of simulatedChannelFrames) {
      framesProcessed++;
      const decodedPacket = packetVisualAdapter.decodePacket(frame);
      receiver.processPacket(decodedPacket);

      if (receiver.isComplete()) {
        break;
      }
    }

    // 8. Verify complete reassembly and SHA-256 match
    expect(framesProcessed).toBeGreaterThan(0);
    expect(receiver.isComplete()).toBe(true);
    const result = receiver.reassemble();

    expect(result.success).toBe(true);
    expect(result.verifiedSha256).toBe(true);
    expect(result.sha256Digest).toBe(originalSha256);
    expect(result.fileBytes.length).toBe(originalFile.length);
    expect(result.fileBytes).toEqual(originalFile);
  });

  describe('Security and Negative Test Cases', () => {
    it('rejects wire packet with corrupted CRC-32 before reaching upper layers', () => {
      const originalFile = generateRealBinaryPayload(2048);
      const blocker = new FileBlocker({ symbolSize, symbolsPerBlock });
      const { manifest, blocks } = blocker.partition(originalFile, 'neg-test.bin');

      const sender = new SenderSession(
        manifest,
        blocks,
        'quick',
        { deviceId: 's', keyPair: crypto.generateKeyPair() },
        crypto,
      );

      const packet = sender.generateEncryptedPacket(0, 0);
      const wireBytes = binaryPacketCodec.encode(packet);

      // Corrupt the 4-byte CRC-32 at the end of the wire bytes
      const corruptedWireBytes = new Uint8Array(wireBytes);
      corruptedWireBytes[corruptedWireBytes.length - 1]! ^= 0xff;

      expect(() => {
        binaryPacketCodec.decode(corruptedWireBytes);
      }).toThrow();
    });

    it('rejects packet with tampered AEAD ciphertext bit-flip (MAC failure)', () => {
      const originalFile = generateRealBinaryPayload(2048);
      const blocker = new FileBlocker({ symbolSize, symbolsPerBlock });
      const { manifest, blocks } = blocker.partition(originalFile, 'neg-test.bin');

      const sender = new SenderSession(
        manifest,
        blocks,
        'quick',
        { deviceId: 's', keyPair: crypto.generateKeyPair() },
        crypto,
      );
      const receiver = ReceiverSession.createQuickSend(sender.getAnnouncement(), undefined, crypto);
      receiver.applyKeyEnvelope(
        sender.handleAuthRequest(receiver.createAuthRequest()).keyEnvelope!,
      );

      const packet = sender.generateEncryptedPacket(0, 0);

      // Flip 1 bit in the encrypted payload (ciphertext or Poly1305 tag)
      const corruptedPayload = new Uint8Array(packet.payload);
      corruptedPayload[10]! ^= 0x01;

      const tamperedPacket: TransportPacket = {
        ...packet,
        payload: corruptedPayload,
      };

      // ChaCha20-Poly1305 authentication check must reject tampered ciphertext
      expect(() => {
        receiver.processPacket(tamperedPacket);
      }).toThrow();
    });

    it('rejects packet with tampered AAD metadata (e.g. altered blockIndex)', () => {
      const originalFile = generateRealBinaryPayload(2048);
      const blocker = new FileBlocker({ symbolSize, symbolsPerBlock });
      const { manifest, blocks } = blocker.partition(originalFile, 'neg-test.bin');

      const sender = new SenderSession(
        manifest,
        blocks,
        'quick',
        { deviceId: 's', keyPair: crypto.generateKeyPair() },
        crypto,
      );
      const receiver = ReceiverSession.createQuickSend(sender.getAnnouncement(), undefined, crypto);
      receiver.applyKeyEnvelope(
        sender.handleAuthRequest(receiver.createAuthRequest()).keyEnvelope!,
      );

      const packet = sender.generateEncryptedPacket(0, 0);

      // Alter blockIndex in the TransportPacket header (which forms part of AAD)
      const tamperedPacket: TransportPacket = {
        ...packet,
        blockIndex: 1, // Changed from 0 to 1
      };

      // AEAD verification must fail due to AAD mismatch
      expect(() => {
        receiver.processPacket(tamperedPacket);
      }).toThrow();
    });

    it('FileReassembler detects corrupted block data and throws Sha256MismatchError', () => {
      const originalFile = generateRealBinaryPayload(2048);
      const blocker = new FileBlocker({ symbolSize, symbolsPerBlock, hasher: portableHasher });
      const { manifest, blocks } = blocker.partition(originalFile, 'test.bin');

      const reassembler = new FileReassembler(manifest, portableHasher);

      for (const block of blocks) {
        if (block.blockIndex === 0) {
          // Corrupt 1 byte in block 0
          const corruptedData = new Uint8Array(block.data);
          corruptedData[100]! ^= 0x5a;
          reassembler.addBlock(block.blockIndex, corruptedData);
        } else {
          reassembler.addBlock(block.blockIndex, block.data);
        }
      }

      expect(reassembler.isComplete()).toBe(true);
      expect(() => {
        reassembler.reassemble();
      }).toThrow(Sha256MismatchError);
    });
  });
});

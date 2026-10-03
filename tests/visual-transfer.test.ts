import { describe, it, expect } from 'vitest';
import {
  FileBlocker,
  SenderSession,
  ReceiverSession,
  computeSha256,
  QrVisualCodec,
  VisualPacketCodec,
  applySaltAndPepperNoise,
} from '@lumalink/core';
import { NodeCryptoProvider } from '@lumalink/core/node';

describe('Phase 3 End-to-End Visual Pipeline Integration', () => {
  const crypto = new NodeCryptoProvider();
  const visualCodec = new QrVisualCodec();
  const packetVisualAdapter = new VisualPacketCodec(visualCodec);

  const symbolSize = 64;
  const symbolsPerBlock = 16; // 1024 bytes per block

  function generatePayload(size: number, seed: number = 999): Uint8Array {
    const buffer = new Uint8Array(size);
    let s = seed >>> 0;
    for (let i = 0; i < size; i++) {
      s = (s + 0x6d2b79f5) >>> 0;
      buffer[i] = (s ^ (s >>> 15)) & 0xff;
    }
    return buffer;
  }

  it('performs complete end-to-end pipeline: File → FEC → AEAD → QR Encode → QR Decode → AEAD → FEC → File → SHA-256', () => {
    // 1. Source file creation
    const originalData = generatePayload(2048, 12345); // 2 full blocks
    const originalHash = computeSha256(originalData);

    const blocker = new FileBlocker({ symbolSize, symbolsPerBlock });
    const { manifest, blocks } = blocker.partition(originalData, 'visual-pipeline-test.bin');

    const senderIdentity = {
      deviceId: 'sender-screen',
      keyPair: crypto.generateKeyPair(),
    };

    // 2. Sender Session & Key Agreement
    const sender = new SenderSession(manifest, blocks, 'quick', senderIdentity, crypto);
    const announcement = sender.getAnnouncement();

    // 3. Receiver Session & Open-Access Envelope Handshake
    const receiver = ReceiverSession.createQuickSend(announcement, undefined, crypto);
    const authRes = sender.handleAuthRequest(receiver.createAuthRequest());
    receiver.applyKeyEnvelope(authRes.keyEnvelope!);

    // 4. Generate encrypted packets, then convert directly to QR visual frames
    const visualFrames = [];
    const overhead = 2.2;

    for (const block of blocks) {
      const count = Math.ceil(block.k * overhead);
      for (let s = 0; s < count; s++) {
        // [Transport Packet + AEAD Encryption]
        const encryptedPacket = sender.generateEncryptedPacket(block.blockIndex, s);

        // [QR Encode: Encrypted Packet → VisualFrame]
        const frame = packetVisualAdapter.encodePacket(encryptedPacket, {
          eccLevel: 'M',
          scale: 4,
        });

        visualFrames.push(frame);
      }
    }

    // 5. Visual Channel Simulation: Frame Dropping (10% loss) and Shuffling
    // Simulates dropped camera frames while preserving sufficient fountain overhead
    const receivedFrames = visualFrames.filter((_, idx) => idx % 10 !== 0);

    // 6. Receiver visual pipeline: [QR Decode → AEAD Decryption → Fountain Peeling]
    for (const frame of receivedFrames) {
      // Decode QR frame image pixels back to TransportPacket
      const packet = packetVisualAdapter.decodePacket(frame);

      // Decrypt and insert into peeling decoder
      receiver.processPacket(packet);

      if (receiver.isComplete()) {
        break;
      }
    }

    // 7. Verify end-to-end file reassembly and cryptographic SHA-256 integrity
    expect(receiver.isComplete()).toBe(true);
    const result = receiver.reassemble();

    expect(result.success).toBe(true);
    expect(result.sha256Digest).toBe(originalHash);
    expect(result.fileBytes).toEqual(originalData);
  });

  it('survives synthetic visual noise across visual transmission frames', () => {
    const originalData = generatePayload(1024, 54321); // 1 block
    const originalHash = computeSha256(originalData);

    const blocker = new FileBlocker({ symbolSize, symbolsPerBlock });
    const { manifest, blocks } = blocker.partition(originalData, 'noisy-visual-test.bin');

    const sender = new SenderSession(
      manifest,
      blocks,
      'quick',
      { deviceId: 'sender', keyPair: crypto.generateKeyPair() },
      crypto,
    );
    const receiver = ReceiverSession.createQuickSend(sender.getAnnouncement(), undefined, crypto);
    receiver.applyKeyEnvelope(sender.handleAuthRequest(receiver.createAuthRequest()).keyEnvelope!);

    const block = blocks[0]!;
    const count = Math.ceil(block.k * 2.6); // 2.6x fountain overhead to absorb visual frame drops

    for (let s = 0; s < count; s++) {
      const pkt = sender.generateEncryptedPacket(0, s);
      const frame = packetVisualAdapter.encodePacket(pkt, { eccLevel: 'M', scale: 4 });

      // Apply synthetic salt-and-pepper pixel noise to visual frame
      const noisyPixelBuffer = applySaltAndPepperNoise(frame.pixelBuffer, 0.005, 1000 + s);

      // Layered Error Model:
      // If noise exceeds QR Reed-Solomon budget, QR decode fails and the frame is dropped.
      // The Luby Transform fountain decoder seamlessly absorbs the dropped visual frame!
      try {
        const decodedPacket = packetVisualAdapter.decodePacket(noisyPixelBuffer);
        receiver.processPacket(decodedPacket);
      } catch {
        // Visual frame dropped — absorbed by fountain code
      }

      if (receiver.isComplete()) break;
    }

    expect(receiver.isComplete()).toBe(true);
    const result = receiver.reassemble();
    expect(result.fileBytes).toEqual(originalData);
    expect(result.sha256Digest).toBe(originalHash);
  });
});

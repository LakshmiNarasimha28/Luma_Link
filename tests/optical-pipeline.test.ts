import { describe, it, expect } from 'vitest';
import {
  FileBlocker,
  SenderSession,
  ReceiverSession,
  computeSha256,
  SenderDisplayHarness,
  ReceiverMeasurementHarness,
  PhysicalOpticalChannelSimulator,
  type TransportPacket,
} from '@lumalink/core';
import { NodeCryptoProvider } from '@lumalink/core/node';

describe('Phase 4 Physical Optical Channel Integration', () => {
  const crypto = new NodeCryptoProvider();

  function generatePayload(size: number, seed: number = 777): Uint8Array {
    const buffer = new Uint8Array(size);
    let s = seed >>> 0;
    for (let i = 0; i < size; i++) {
      s = (s + 0x6d2b79f5) >>> 0;
      buffer[i] = (s ^ (s >>> 15)) & 0xff;
    }
    return buffer;
  }

  it('Stage 1: Smallest Real Optical Pipeline (Known Payload → TransportPacket → QR → Optical Channel → QR Decode → TransportPacket)', () => {
    const rawPayload = new TextEncoder().encode('LumaLink Optical Handshake Symbol #42');

    const originalPacket: TransportPacket = {
      protocolVersion: 1,
      packetType: 'data',
      flags: 0,
      sessionId: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
      blockIndex: 0,
      symbolId: 42,
      fecMetadata: { k: 1, degree: 1 },
      payload: rawPayload,
    };

    // 1. Sender display harness generates QR visual frame
    const sender = new SenderDisplayHarness({
      scale: 5,
      eccLevel: 'M',
      repetitionCount: 2,
    });
    const visualFrames = sender.encodePackets([originalPacket]);
    expect(visualFrames.length).toBe(1);

    // 2. Optical channel simulates screen refresh (15 Hz) vs camera sensor (30 FPS) with R=2 repetition
    // Screen holds frame for 2 * 66.6ms = 133.3ms. Camera samples every 33.3ms -> 4 camera frames!
    const simulator = new PhysicalOpticalChannelSimulator({
      displayRefreshHz: 15,
      cameraCaptureFps: 30,
      repetitionCount: 2,
      pixelFormat: 'rgba8888',
    });

    const capturedFrames = simulator.generateFrames(visualFrames, 1000);
    expect(capturedFrames.length).toBe(4);

    // 3. Receiver measurement harness ingests camera frames
    const receiver = new ReceiverMeasurementHarness({
      cameraDuplicateThresholdMs: 40,
    });

    const receivedPackets: TransportPacket[] = [];
    receiver.onPacketReceived((packet) => {
      receivedPackets.push(packet);
    });

    const processingResults = capturedFrames.map((frame) => receiver.processFrame(frame));

    // Verify all 4 camera frames detected the QR symbol
    expect(processingResults.every((r) => r.qrDetected)).toBe(true);

    // Verify three-tier deduplication:
    // Only the very first frame should be delivered as novel; the rest should be camera duplicates or frame repetitions
    expect(receivedPackets.length).toBe(1);
    const delivered = receivedPackets[0]!;

    // Byte-for-byte comparison of TransportPacket fields
    expect(delivered.protocolVersion).toBe(originalPacket.protocolVersion);
    expect(delivered.packetType).toBe(originalPacket.packetType);
    expect(delivered.sessionId).toBe(originalPacket.sessionId);
    expect(delivered.blockIndex).toBe(originalPacket.blockIndex);
    expect(delivered.symbolId).toBe(originalPacket.symbolId);
    expect(delivered.fecMetadata).toEqual(originalPacket.fecMetadata);
    expect(delivered.payload).toEqual(originalPacket.payload);

    const snapshot = receiver.getMetricsSnapshot();
    expect(snapshot.uniquePacketsDelivered).toBe(1);
    expect(snapshot.totalFramesReceived).toBe(4);
    expect(snapshot.level2OpticalGoodputBps).toBeGreaterThan(0);
  });

  it('Stage 2: Full End-to-End Optical Transfer (File → FEC → AEAD → QR → Display → Camera → QR Decode → AEAD → FEC → File → SHA-256)', () => {
    // 1. Source file setup (2 KB = 2 blocks of 16 symbols * 64 bytes)
    const originalFile = generatePayload(2048, 99999);
    const originalSha256 = computeSha256(originalFile);

    const blocker = new FileBlocker({ symbolSize: 64, symbolsPerBlock: 16 });
    const { manifest, blocks } = blocker.partition(originalFile, 'optical-transfer-test.bin');

    const senderIdentity = {
      deviceId: 'sender-device-android-1',
      keyPair: crypto.generateKeyPair(),
    };

    const senderSession = new SenderSession(manifest, blocks, 'quick', senderIdentity, crypto);
    const announcement = senderSession.getAnnouncement();

    const receiverSession = ReceiverSession.createQuickSend(announcement, undefined, crypto);
    const authResponse = senderSession.handleAuthRequest(receiverSession.createAuthRequest());
    receiverSession.applyKeyEnvelope(authResponse.keyEnvelope!);

    // 2. Generate encrypted packets
    const fountainOverhead = 2.4; // 2.4x overhead absorbs simulated optical frame drops
    const allPackets: TransportPacket[] = [];

    for (const block of blocks) {
      const symbolsToSend = Math.ceil(block.k * fountainOverhead);
      for (let s = 0; s < symbolsToSend; s++) {
        allPackets.push(senderSession.generateEncryptedPacket(block.blockIndex, s));
      }
    }

    // 3. Sender Display Harness encodes into QR visual frames
    const senderHarness = new SenderDisplayHarness({
      scale: 4,
      eccLevel: 'M',
      repetitionCount: 1,
    });
    const visualFrames = senderHarness.encodePackets(allPackets);

    // 4. Optical Channel Simulator:
    // Display refresh: 20 Hz (50 ms)
    // Camera capture: 30 FPS (33.3 ms)
    // Optical drop rate: 10% (intermittent occlusion / field-of-view loss)
    // Timing jitter: 2.0 ms
    const simulator = new PhysicalOpticalChannelSimulator({
      displayRefreshHz: 20,
      cameraCaptureFps: 30,
      repetitionCount: 1,
      dropRate: 0.1, // 10% optical loss
      jitterMs: 2.0,
      seed: 42,
    });

    const startClock = 5000;
    const capturedFrames = simulator.generateFrames(visualFrames, startClock);
    expect(capturedFrames.length).toBeGreaterThan(visualFrames.length);

    // 5. Receiver Measurement Harness
    const receiverHarness = new ReceiverMeasurementHarness({
      cameraDuplicateThresholdMs: 40,
    });

    receiverHarness.onPacketReceived((packet) => {
      receiverSession.processPacket(packet);
    });

    // Ingest captured camera frames into receiver
    for (const frame of capturedFrames) {
      receiverHarness.processFrame(frame);
      if (receiverSession.isComplete()) {
        break;
      }
    }

    // 6. Verify transfer completion, file reassembly, and cryptographic SHA-256 match
    expect(receiverSession.isComplete()).toBe(true);

    const reassemblyResult = receiverSession.reassemble();
    expect(reassemblyResult.success).toBe(true);
    expect(reassemblyResult.sha256Digest).toBe(originalSha256);
    expect(reassemblyResult.fileBytes).toEqual(originalFile);

    // 7. Verify optical channel metrics & Level 3 Goodput accounting
    const completionTime = startClock + 4000;
    receiverHarness.recordVerifiedTransfer(originalFile.length, completionTime);

    const metrics = receiverHarness.getMetricsSnapshot();
    expect(metrics.totalFramesReceived).toBeGreaterThan(0);
    expect(metrics.totalQrFramesDetected).toBeGreaterThan(0);
    expect(metrics.qrDetectionRate).toBeGreaterThan(0.8);
    expect(metrics.uniquePacketsDelivered).toBeGreaterThanOrEqual(blocks.length * 16);
    expect(metrics.cameraFrameDuplicates).toBeGreaterThan(0);

    // Performance Layer Verification:
    // Level 1: QR software decode throughput (bytes/s)
    expect(metrics.level1CodecThroughputBps).toBeGreaterThan(1000);
    // Level 2: Physical optical goodput (bytes/s)
    expect(metrics.level2OpticalGoodputBps).toBeGreaterThan(100);
    // Level 3: End-to-end verified goodput (bytes/s)
    expect(metrics.level3EndToEndGoodputBps).toBeGreaterThan(0);
  });
});

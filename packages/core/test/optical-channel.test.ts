import { describe, it, expect } from 'vitest';
import {
  createCapturedFrame,
  DefaultCapturedFrame,
  OpticalMetricsCollector,
  OpticalFrameDeduplicator,
  PhysicalOpticalChannelSimulator,
  SenderDisplayHarness,
  ReceiverMeasurementHarness,
} from '../src/optical/index.js';
import { QrVisualCodec } from '../src/visual/qr-codec.js';
import type { TransportPacket } from '../src/packet/types.js';

describe('Phase 4 Optical Channel Abstraction & Platform Separation', () => {
  describe('CapturedFrame & PixelFormat Conversions', () => {
    it('creates a DefaultCapturedFrame with RGBA format', () => {
      const data = new Uint8ClampedArray(4 * 4 * 4); // 4x4 RGBA
      data.fill(200);

      const frame = createCapturedFrame({
        sequenceNumber: 1,
        timestampMs: 1000,
        width: 4,
        height: 4,
        pixelFormat: 'rgba8888',
        data,
        metadata: {
          sensorTimestampNs: 1_000_000_000,
          rotationDegrees: 90,
          lensFacing: 'back',
        },
      });

      expect(frame.sequenceNumber).toBe(1);
      expect(frame.timestampMs).toBe(1000);
      expect(frame.width).toBe(4);
      expect(frame.height).toBe(4);
      expect(frame.pixelFormat).toBe('rgba8888');
      expect(frame.metadata.rotationDegrees).toBe(90);
      expect(frame.metadata.lensFacing).toBe('back');

      const pixelBuffer = frame.toPixelBuffer();
      expect(pixelBuffer.width).toBe(4);
      expect(pixelBuffer.height).toBe(4);
      expect(pixelBuffer.data.length).toBe(64);
      expect(pixelBuffer.data[0]).toBe(200);
    });

    it('converts grayscale luminance plane to RGBA PixelBuffer', () => {
      const grayData = new Uint8Array([10, 50, 100, 255]); // 2x2 grayscale
      const frame = new DefaultCapturedFrame({
        sequenceNumber: 2,
        width: 2,
        height: 2,
        pixelFormat: 'grayscale',
        data: grayData,
      });

      const pixelBuffer = frame.toPixelBuffer();
      expect(pixelBuffer.width).toBe(2);
      expect(pixelBuffer.height).toBe(2);
      expect(pixelBuffer.data.length).toBe(16); // 4 pixels * 4 bytes

      // Pixel 0: gray 10 -> R=10, G=10, B=10, A=255
      expect(pixelBuffer.data[0]).toBe(10);
      expect(pixelBuffer.data[1]).toBe(10);
      expect(pixelBuffer.data[2]).toBe(10);
      expect(pixelBuffer.data[3]).toBe(255);

      // Pixel 3: gray 255 -> R=255, G=255, B=255, A=255
      expect(pixelBuffer.data[12]).toBe(255);
      expect(pixelBuffer.data[13]).toBe(255);
      expect(pixelBuffer.data[14]).toBe(255);
      expect(pixelBuffer.data[15]).toBe(255);
    });

    it('converts YUV420 / NV21 Y-plane to RGBA PixelBuffer', () => {
      // 2x2 Y plane (4 bytes) + UV plane (2 bytes) = 6 bytes
      const yuvData = new Uint8Array([128, 128, 64, 64, 200, 200]);
      const frame = createCapturedFrame({
        sequenceNumber: 3,
        width: 2,
        height: 2,
        pixelFormat: 'yuv420',
        data: yuvData,
      });

      const pixelBuffer = frame.toPixelBuffer();
      expect(pixelBuffer.width).toBe(2);
      expect(pixelBuffer.height).toBe(2);
      expect(pixelBuffer.data.length).toBe(16);

      // Check pixel 2 (index 2): Y=64 -> R=64, G=64, B=64, A=255
      expect(pixelBuffer.data[8]).toBe(64);
      expect(pixelBuffer.data[9]).toBe(64);
      expect(pixelBuffer.data[10]).toBe(64);
      expect(pixelBuffer.data[11]).toBe(255);
    });
  });

  describe('OpticalMetricsCollector', () => {
    it('computes frame arrival intervals, observed FPS, and interval jitter', () => {
      const collector = new OpticalMetricsCollector({ windowSize: 10 });

      // Simulate 5 frames arriving at ~33.3ms intervals (30 FPS) with slight jitter:
      // Intervals: 33ms, 35ms, 31ms, 34ms
      collector.recordFrameArrival(1000);
      collector.recordFrameArrival(1033);
      collector.recordFrameArrival(1068);
      collector.recordFrameArrival(1099);
      collector.recordFrameArrival(1133);

      const snapshot = collector.getSnapshot();
      expect(snapshot.totalFramesReceived).toBe(5);
      // Mean interval = (33 + 35 + 31 + 34) / 4 = 133 / 4 = 33.25 ms
      expect(snapshot.meanFrameIntervalMs).toBeCloseTo(33.25, 1);
      // Observed FPS = 1000 / 33.25 ~= 30.08 FPS
      expect(snapshot.observedFps).toBeCloseTo(30.08, 1);
      expect(snapshot.frameIntervalJitterMs).toBeGreaterThan(0);
      expect(snapshot.elapsedDurationMs).toBe(133);
    });

    it('tracks three performance layers: Codec (L1), Optical Goodput (L2), End-to-End Goodput (L3)', () => {
      const collector = new OpticalMetricsCollector();

      // Record arrivals: 0ms to 1000ms
      collector.recordFrameArrival(1000);
      collector.recordFrameArrival(2000);

      // Record QR decode result: 500 bytes decoded in 25ms CPU time
      collector.recordProcessingResult({
        frameSequence: 1,
        qrDetected: true,
        decodeLatencyMs: 25,
        classification: 'novel',
        payloadBytes: 500,
        packetIdentifier: 'session1:0:1',
      });

      // Record duplicate
      collector.recordProcessingResult({
        frameSequence: 2,
        qrDetected: true,
        decodeLatencyMs: 25,
        classification: 'camera_duplicate',
        payloadBytes: 500,
      });

      // Record SHA-256 verified transfer: 1000 bytes at timestamp 2000ms
      collector.recordVerifiedTransfer(1000, 2000);

      const snapshot = collector.getSnapshot();

      expect(snapshot.totalQrFramesDetected).toBe(2);
      expect(snapshot.totalFramesReceived).toBe(2);
      expect(snapshot.cameraFrameDuplicates).toBe(1);
      expect(snapshot.uniquePacketsDelivered).toBe(1);

      // Level 1: 1000 bytes total decoded / 50ms CPU time = 20,000 bytes/sec
      expect(snapshot.level1CodecThroughputBps).toBe(20000);

      // Level 2: 500 unique bytes / 1.0 second elapsed = 500 bytes/sec
      expect(snapshot.level2OpticalGoodputBps).toBe(500);

      // Level 3: 1000 verified file bytes / 1.0 second transfer duration = 1000 bytes/sec
      expect(snapshot.level3EndToEndGoodputBps).toBe(1000);
    });
  });

  describe('OpticalFrameDeduplicator (Three-Tier Model)', () => {
    it('accurately classifies camera duplicates, visual frame repetitions, and packet duplicates', () => {
      const deduplicator = new OpticalFrameDeduplicator({
        cameraDuplicateThresholdMs: 40,
      });

      const payloadA = new Uint8Array([1, 2, 3, 4]);
      const payloadB = new Uint8Array([5, 6, 7, 8]);

      // 1. First arrival of payload A -> novel
      const c1 = deduplicator.classify(payloadA, 's1:0:1', 1000);
      expect(c1).toBe('novel');

      // 2. Camera duplicate of payload A (arriving 16ms later, < 40ms threshold)
      const c2 = deduplicator.classify(payloadA, 's1:0:1', 1016);
      expect(c2).toBe('camera_duplicate');

      // 3. Sender frame repetition of payload A (arriving 70ms later, > 40ms threshold)
      const c3 = deduplicator.classify(payloadA, 's1:0:1', 1086);
      expect(c3).toBe('frame_repetition');

      // 4. Novel payload B -> novel
      const c4 = deduplicator.classify(payloadB, 's1:0:2', 1150);
      expect(c4).toBe('novel');

      // 5. Another payload with previously seen packetId 's1:0:1' -> packet_duplicate
      const payloadC = new Uint8Array([9, 10, 11, 12]);
      const c5 = deduplicator.classify(payloadC, 's1:0:1', 1220);
      expect(c5).toBe('packet_duplicate');
    });

    it('ensures distinct packets arriving rapidly within timing threshold are NOT classified as camera duplicates', () => {
      const deduplicator = new OpticalFrameDeduplicator({
        cameraDuplicateThresholdMs: 40,
      });

      const payload1 = new Uint8Array([10, 20, 30]);
      const payload2 = new Uint8Array([40, 50, 60]);

      // Arrive only 5ms apart (well under the 40ms threshold)
      const res1 = deduplicator.classify(payload1, 'session:0:1', 1000);
      const res2 = deduplicator.classify(payload2, 'session:0:2', 1005);

      // Distinct transport packet identity and payload MUST be recognized as novel
      expect(res1).toBe('novel');
      expect(res2).toBe('novel');
    });

    it('preserves packet identity authority across alternating frame sequences (A -> B -> A)', () => {
      const deduplicator = new OpticalFrameDeduplicator();

      const payloadA = new Uint8Array([1, 1, 1]);
      const payloadB = new Uint8Array([2, 2, 2]);

      expect(deduplicator.classify(payloadA, 'pkt-A', 1000)).toBe('novel');
      expect(deduplicator.classify(payloadB, 'pkt-B', 1050)).toBe('novel');

      // Frame A reappears after B:
      // Even though payload is identical to an earlier frame, visual transition occurred (B -> A).
      // Transport packet identity 'pkt-A' has already been received, so it is authoritative packet_duplicate.
      expect(deduplicator.classify(payloadA, 'pkt-A', 1100)).toBe('packet_duplicate');
    });
  });

  describe('SenderDisplayHarness', () => {
    it('generates sequential and repetitive test sequences', () => {
      const sender = new SenderDisplayHarness({
        scale: 4,
        eccLevel: 'M',
        repetitionCount: 2,
      });

      const seq = sender.generateTestSequence(['A', 'B']);
      expect(seq.length).toBe(4); // A, A, B, B
      expect(seq[0]!.metadata.eccLevel).toBe('M');
    });

    it('encodes TransportPackets with configurable scaling and quiet zone', () => {
      const sender = new SenderDisplayHarness({
        scale: 6,
        eccLevel: 'L',
        quietZone: 4,
      });

      const dummyPacket: TransportPacket = {
        protocolVersion: 1,
        packetType: 'data',
        flags: 0,
        sessionId: 'test-session-001',
        blockIndex: 0,
        symbolId: 1,
        fecMetadata: { k: 10, degree: 1 },
        payload: new Uint8Array([10, 20, 30, 40]),
      };

      const frames = sender.encodePackets([dummyPacket]);
      expect(frames.length).toBe(1);
      expect(frames[0]!.pixelBuffer.width).toBeGreaterThan(0);
      expect(frames[0]!.metadata.eccLevel).toBe('L');
    });
  });

  describe('PhysicalOpticalChannelSimulator & ReceiverMeasurementHarness Integration', () => {
    it('simulates optical link with refresh rate vs camera FPS oversampling', () => {
      const sender = new SenderDisplayHarness({
        scale: 4,
        eccLevel: 'M',
        repetitionCount: 1,
      });

      // 4 visual frames: A, B, C, D
      const visualFrames = sender.generateTestSequence(['A', 'B', 'C', 'D']);

      // Screen refresh: 15 Hz (66.6ms per frame)
      // Camera capture: 30 FPS (33.3ms per frame)
      // Each visual frame will be sampled ~2 times by the camera!
      const simulator = new PhysicalOpticalChannelSimulator({
        displayRefreshHz: 15,
        cameraCaptureFps: 30,
        repetitionCount: 1,
        dropRate: 0,
        pixelFormat: 'rgba8888',
      });

      const capturedFrames = simulator.generateFrames(visualFrames, 1000);
      expect(capturedFrames.length).toBe(8); // 4 frames * 2 camera samples

      // Ingest captured frames into receiver harness
      const receiver = new ReceiverMeasurementHarness({
        cameraDuplicateThresholdMs: 40,
      });

      const results = capturedFrames.map((f) => receiver.processFrame(f));

      // All 8 frames should be successfully detected by QR decoder
      expect(results.every((r) => r.qrDetected)).toBe(true);

      const snapshot = receiver.getMetricsSnapshot();
      expect(snapshot.totalFramesReceived).toBe(8);
      expect(snapshot.totalQrFramesDetected).toBe(8);
      expect(snapshot.totalQrDecodeFailures).toBe(0);
      expect(snapshot.qrDetectionRate).toBe(1.0);

      // Exactly 4 should be novel, and 4 should be camera_duplicate
      const novelCount = results.filter((r) => r.classification === 'novel').length;
      const cameraDupCount = results.filter((r) => r.classification === 'camera_duplicate').length;

      expect(novelCount).toBe(4);
      expect(cameraDupCount).toBe(4);
      expect(snapshot.cameraFrameDuplicates).toBe(4);
      expect(snapshot.uniquePacketsDelivered).toBe(4);
    });

    it('simulates optical occlusion drop rate and glare corruption', () => {
      const sender = new SenderDisplayHarness({ scale: 4 });
      const visualFrames = sender.generateTestSequence(['TEST_1', 'TEST_2']);

      // 50% glare rate on optical simulator
      const simulator = new PhysicalOpticalChannelSimulator({
        displayRefreshHz: 30,
        cameraCaptureFps: 30,
        glareRate: 0.5,
        seed: 42,
      });

      const captured = simulator.generateFrames(visualFrames, 1000);
      const receiver = new ReceiverMeasurementHarness();

      captured.forEach((f) => receiver.processFrame(f));
      const snapshot = receiver.getMetricsSnapshot();

      // Corrupted frames fail QR decoding as expected
      expect(snapshot.totalQrDecodeFailures).toBeGreaterThan(0);
      expect(snapshot.qrDetectionRate).toBeLessThan(1.0);
    });

    it('works across different pixel formats (grayscale luminance)', () => {
      const visualCodec = new QrVisualCodec();
      const payload = new TextEncoder().encode('LumaLink Optical Format Test');
      const visualFrame = visualCodec.encode(payload, { scale: 5 });

      const simulator = new PhysicalOpticalChannelSimulator({
        displayRefreshHz: 30,
        cameraCaptureFps: 30,
        pixelFormat: 'grayscale', // Camera delivers Y-channel luminance
      });

      const captured = simulator.generateFrames([visualFrame], 1000);
      expect(captured.length).toBe(1);
      expect(captured[0]!.pixelFormat).toBe('grayscale');

      const receiver = new ReceiverMeasurementHarness();
      const result = receiver.processFrame(captured[0]!);

      expect(result.qrDetected).toBe(true);
      expect(result.classification).toBe('novel');
      expect(result.payloadBytes).toBe(payload.length);
    });
  });
});

import type { VisualCodec } from '../visual/types.js';
import { QrVisualCodec } from '../visual/qr-codec.js';
import type { TransportPacket } from '../packet/types.js';
import { VisualPacketCodec } from '../visual/packet-adapter.js';
import type {
  CapturedFrame,
  FrameProcessingResult,
  OpticalChannelMetricsSnapshot,
} from './types.js';
import { OpticalMetricsCollector } from './metrics-collector.js';
import { OpticalFrameDeduplicator } from './frame-deduplicator.js';

export interface ReceiverHarnessOptions {
  readonly visualCodec?: VisualCodec | undefined;
  /** Max milliseconds between consecutive identical frames to classify as camera duplicate */
  readonly cameraDuplicateThresholdMs?: number | undefined;
  /** Sliding window size for FPS and jitter computation */
  readonly metricsWindowSize?: number | undefined;
}

export type FrameProcessedListener = (result: FrameProcessingResult, frame: CapturedFrame) => void;
export type PacketReceivedListener = (packet: TransportPacket, rawPayload: Uint8Array) => void;

/**
 * Receiver optical measurement harness.
 * Coordinates camera frame ingestion, high-precision latency measurement,
 * QR decoding, duplicate classification, packet extraction, and metrics aggregation.
 */
export class ReceiverMeasurementHarness {
  readonly visualCodec: VisualCodec;
  readonly packetCodec: VisualPacketCodec;
  readonly metricsCollector: OpticalMetricsCollector;
  readonly deduplicator: OpticalFrameDeduplicator;

  private frameProcessedListeners: FrameProcessedListener[] = [];
  private packetReceivedListeners: PacketReceivedListener[] = [];

  constructor(options?: ReceiverHarnessOptions) {
    this.visualCodec = options?.visualCodec ?? new QrVisualCodec();
    this.packetCodec = new VisualPacketCodec(this.visualCodec);
    this.metricsCollector = new OpticalMetricsCollector({
      windowSize: options?.metricsWindowSize,
    });
    this.deduplicator = new OpticalFrameDeduplicator({
      cameraDuplicateThresholdMs: options?.cameraDuplicateThresholdMs,
    });
  }

  /**
   * Subscribes to per-frame measurement results.
   */
  onFrameProcessed(listener: FrameProcessedListener): () => void {
    this.frameProcessedListeners.push(listener);
    return () => {
      this.frameProcessedListeners = this.frameProcessedListeners.filter((l) => l !== listener);
    };
  }

  /**
   * Subscribes to novel transport packets successfully recovered from the optical channel.
   */
  onPacketReceived(listener: PacketReceivedListener): () => void {
    this.packetReceivedListeners.push(listener);
    return () => {
      this.packetReceivedListeners = this.packetReceivedListeners.filter((l) => l !== listener);
    };
  }

  /**
   * Resets all internal state, deduplication memory, and optical metrics.
   */
  reset(): void {
    this.metricsCollector.reset();
    this.deduplicator.reset();
  }

  /**
   * Ingests and processes a single captured optical frame from a camera or simulator.
   * Measures latency, decodes visual QR, classifies duplicates, and forwards packets.
   */
  processFrame(frame: CapturedFrame): FrameProcessingResult {
    this.metricsCollector.recordFrameArrival(frame.timestampMs);

    const pixelBuffer = frame.toPixelBuffer();
    const startTime = performance.now();

    let rawPayload: Uint8Array | undefined;
    let decodeError: string | undefined;

    try {
      rawPayload = this.visualCodec.decode(pixelBuffer);
    } catch (err) {
      decodeError = err instanceof Error ? err.message : String(err);
    }

    const decodeEndTime = performance.now();
    const decodeLatencyMs = Math.round((decodeEndTime - startTime) * 100) / 100;

    if (!rawPayload) {
      // Decode failed / QR not detected
      const failureResult: FrameProcessingResult = {
        frameSequence: frame.sequenceNumber,
        qrDetected: false,
        decodeLatencyMs,
        classification: 'camera_duplicate', // Neutral classification when no QR detected
        error: decodeError,
      };

      this.metricsCollector.recordProcessingResult(failureResult);
      this.notifyFrameProcessed(failureResult, frame);
      return failureResult;
    }

    // QR detected successfully. Attempt to parse as TransportPacket.
    let packet: TransportPacket | undefined;
    let packetIdentifier: string | undefined;

    try {
      packet = this.packetCodec.packetCodec.decode(rawPayload);
      packetIdentifier = `${packet.sessionId}:${packet.blockIndex}:${packet.symbolId}`;
    } catch {
      // Raw payload is not a LumaLink TransportPacket (e.g. test string or arbitrary payload)
      packetIdentifier = undefined;
    }

    // Classify duplicate tier
    const classification = this.deduplicator.classify(
      rawPayload,
      packetIdentifier,
      frame.timestampMs,
    );

    const successResult: FrameProcessingResult = {
      frameSequence: frame.sequenceNumber,
      qrDetected: true,
      decodeLatencyMs,
      classification,
      payloadBytes: rawPayload.length,
      packetIdentifier,
    };

    this.metricsCollector.recordProcessingResult(successResult);

    if (classification === 'novel' && packet) {
      this.notifyPacketReceived(packet, rawPayload);
    }

    this.notifyFrameProcessed(successResult, frame);
    return successResult;
  }

  /**
   * Records SHA-256 verified file completion to compute Level 3 Goodput.
   */
  recordVerifiedTransfer(verifiedBytes: number, completionTimestampMs?: number): void {
    this.metricsCollector.recordVerifiedTransfer(verifiedBytes, completionTimestampMs);
  }

  /**
   * Returns a snapshot of optical channel statistics and performance metrics.
   */
  getMetricsSnapshot(): OpticalChannelMetricsSnapshot {
    return this.metricsCollector.getSnapshot();
  }

  private notifyFrameProcessed(result: FrameProcessingResult, frame: CapturedFrame): void {
    for (const listener of this.frameProcessedListeners) {
      try {
        listener(result, frame);
      } catch (err) {
        console.error('Error in frameProcessedListener:', err);
      }
    }
  }

  private notifyPacketReceived(packet: TransportPacket, rawPayload: Uint8Array): void {
    for (const listener of this.packetReceivedListeners) {
      try {
        listener(packet, rawPayload);
      } catch (err) {
        console.error('Error in packetReceivedListener:', err);
      }
    }
  }
}

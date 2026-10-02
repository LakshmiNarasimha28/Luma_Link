import type { FrameProcessingResult, OpticalChannelMetricsSnapshot } from './types.js';

export interface OpticalMetricsOptions {
  /** Maximum number of recent frame intervals to retain for sliding-window jitter and FPS (default: 60) */
  readonly windowSize?: number | undefined;
}

/**
 * High-precision metrics collector for the physical optical channel.
 * Computes observed FPS, frame-interval jitter, QR detection rates,
 * and maintains the three strict performance layers (Level 1, Level 2, Level 3).
 */
export class OpticalMetricsCollector {
  private readonly windowSize: number;

  // Physical frame counters
  private totalFramesReceived = 0;
  private totalFramesDropped = 0;
  private lastFrameTimestampMs = 0;
  private startTimeMs = 0;
  private lastActiveTimestampMs = 0;

  // Sliding window of frame intervals (ms)
  private readonly intervalWindow: number[] = [];

  // QR detection counters
  private totalQrFramesDetected = 0;
  private totalQrDecodeFailures = 0;
  private totalDecodeLatencyMs = 0;
  private totalPayloadBytesDecoded = 0;

  // Duplicate analysis counters
  private cameraFrameDuplicates = 0;
  private visualFrameRepetitions = 0;
  private transportPacketDuplicates = 0;
  private uniquePacketsDelivered = 0;
  private uniquePayloadBytesDelivered = 0;

  // Level 3 end-to-end verified transfer metrics
  private verifiedFileBytes = 0;
  private transferCompletedTimeMs = 0;

  constructor(options?: OpticalMetricsOptions) {
    this.windowSize = options?.windowSize ?? 60;
  }

  /**
   * Resets all metrics for a fresh measurement run.
   */
  reset(): void {
    this.totalFramesReceived = 0;
    this.totalFramesDropped = 0;
    this.lastFrameTimestampMs = 0;
    this.startTimeMs = 0;
    this.lastActiveTimestampMs = 0;
    this.intervalWindow.length = 0;

    this.totalQrFramesDetected = 0;
    this.totalQrDecodeFailures = 0;
    this.totalDecodeLatencyMs = 0;
    this.totalPayloadBytesDecoded = 0;

    this.cameraFrameDuplicates = 0;
    this.visualFrameRepetitions = 0;
    this.transportPacketDuplicates = 0;
    this.uniquePacketsDelivered = 0;
    this.uniquePayloadBytesDelivered = 0;

    this.verifiedFileBytes = 0;
    this.transferCompletedTimeMs = 0;
  }

  /**
   * Records the arrival of a raw captured frame from the optical sensor.
   */
  recordFrameArrival(timestampMs: number): void {
    if (this.startTimeMs === 0) {
      this.startTimeMs = timestampMs;
    }
    this.lastActiveTimestampMs = timestampMs;
    this.totalFramesReceived++;

    if (this.lastFrameTimestampMs > 0) {
      const interval = timestampMs - this.lastFrameTimestampMs;
      if (interval >= 0) {
        this.intervalWindow.push(interval);
        if (this.intervalWindow.length > this.windowSize) {
          this.intervalWindow.shift();
        }
      }
    }
    this.lastFrameTimestampMs = timestampMs;
  }

  /**
   * Records dropped frames (e.g. sensor backpressure, frame skipping).
   */
  recordFramesDropped(count: number = 1): void {
    this.totalFramesDropped += count;
  }

  /**
   * Records the result of processing / decoding an optical frame.
   */
  recordProcessingResult(result: FrameProcessingResult): void {
    if (result.qrDetected) {
      this.totalQrFramesDetected++;
      this.totalDecodeLatencyMs += result.decodeLatencyMs;
      if (result.payloadBytes !== undefined && result.payloadBytes > 0) {
        this.totalPayloadBytesDecoded += result.payloadBytes;
      }

      switch (result.classification) {
        case 'camera_duplicate':
          this.cameraFrameDuplicates++;
          break;
        case 'frame_repetition':
          this.visualFrameRepetitions++;
          break;
        case 'packet_duplicate':
          this.transportPacketDuplicates++;
          break;
        case 'novel':
          this.uniquePacketsDelivered++;
          if (result.payloadBytes !== undefined && result.payloadBytes > 0) {
            this.uniquePayloadBytesDelivered += result.payloadBytes;
          }
          break;
      }
    } else {
      this.totalQrDecodeFailures++;
    }
  }

  /**
   * Records end-to-end completion and SHA-256 verified file bytes.
   */
  recordVerifiedTransfer(verifiedBytes: number, completionTimestampMs?: number): void {
    this.verifiedFileBytes += verifiedBytes;
    this.transferCompletedTimeMs = completionTimestampMs ?? Date.now();
  }

  /**
   * Generates a complete snapshot of all optical channel metrics.
   */
  getSnapshot(): OpticalChannelMetricsSnapshot {
    const elapsedDurationMs =
      this.startTimeMs > 0
        ? Math.max(0, (this.lastActiveTimestampMs || Date.now()) - this.startTimeMs)
        : 0;

    // Compute interval mean and jitter
    let meanFrameIntervalMs = 0;
    let frameIntervalJitterMs = 0;
    let observedFps = 0;

    if (this.intervalWindow.length > 0) {
      const sum = this.intervalWindow.reduce((a, b) => a + b, 0);
      meanFrameIntervalMs = sum / this.intervalWindow.length;

      // Mean Absolute Deviation (MAD) for jitter
      const madSum = this.intervalWindow.reduce(
        (acc, val) => acc + Math.abs(val - meanFrameIntervalMs),
        0,
      );
      frameIntervalJitterMs = madSum / this.intervalWindow.length;

      if (meanFrameIntervalMs > 0) {
        observedFps = 1000 / meanFrameIntervalMs;
      }
    }

    const totalDecodesAttempted = this.totalQrFramesDetected + this.totalQrDecodeFailures;
    const qrDetectionRate =
      totalDecodesAttempted > 0 ? this.totalQrFramesDetected / totalDecodesAttempted : 0;

    const meanDecodeLatencyMs =
      this.totalQrFramesDetected > 0 ? this.totalDecodeLatencyMs / this.totalQrFramesDetected : 0;

    // --- LEVEL 1: Software Codec Throughput ---
    // Pure software compute throughput: decoded bytes / total decode CPU time in seconds
    const totalDecodeSec = this.totalDecodeLatencyMs / 1000;
    const level1CodecThroughputBps =
      totalDecodeSec > 0 ? this.totalPayloadBytesDecoded / totalDecodeSec : 0;

    // --- LEVEL 2: Optical Goodput ---
    // Effective physical optical goodput: delivered unique packet bytes / total elapsed wall-clock seconds
    const elapsedSec = elapsedDurationMs / 1000;
    const level2OpticalGoodputBps =
      elapsedSec > 0 ? this.uniquePayloadBytesDelivered / elapsedSec : 0;

    // --- LEVEL 3: End-to-End Verified Goodput ---
    // Verified reconstructed file bytes / total transfer wall-clock seconds
    const transferDurationMs =
      this.transferCompletedTimeMs > 0 && this.startTimeMs > 0
        ? Math.max(1, this.transferCompletedTimeMs - this.startTimeMs)
        : elapsedDurationMs;
    const transferSec = transferDurationMs / 1000;
    const level3EndToEndGoodputBps =
      transferSec > 0 && this.verifiedFileBytes > 0 ? this.verifiedFileBytes / transferSec : 0;

    return {
      totalFramesReceived: this.totalFramesReceived,
      totalFramesDropped: this.totalFramesDropped,
      observedFps: Math.round(observedFps * 100) / 100,
      meanFrameIntervalMs: Math.round(meanFrameIntervalMs * 100) / 100,
      frameIntervalJitterMs: Math.round(frameIntervalJitterMs * 100) / 100,

      totalQrFramesDetected: this.totalQrFramesDetected,
      totalQrDecodeFailures: this.totalQrDecodeFailures,
      qrDetectionRate: Math.round(qrDetectionRate * 10000) / 10000,
      meanDecodeLatencyMs: Math.round(meanDecodeLatencyMs * 100) / 100,

      cameraFrameDuplicates: this.cameraFrameDuplicates,
      visualFrameRepetitions: this.visualFrameRepetitions,
      transportPacketDuplicates: this.transportPacketDuplicates,
      uniquePacketsDelivered: this.uniquePacketsDelivered,

      level1CodecThroughputBps: Math.round(level1CodecThroughputBps * 100) / 100,
      level2OpticalGoodputBps: Math.round(level2OpticalGoodputBps * 100) / 100,
      level3EndToEndGoodputBps: Math.round(level3EndToEndGoodputBps * 100) / 100,

      elapsedDurationMs,
    };
  }
}

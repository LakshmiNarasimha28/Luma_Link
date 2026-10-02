/**
 * Optical Channel Abstractions and Physical Capture Models for LumaLink.
 *
 * CRITICAL ARCHITECTURAL INVARIANT:
 * QR remains a VISUAL CODEC. QR is NOT the transport protocol.
 * The optical layer represents the physical visual-light propagation channel
 * (display screen → light → camera sensor) and remains completely independent
 * of FEC, encryption, sessions, and file logic.
 */

import type { PixelBuffer, VisualFrame } from '../visual/types.js';

export type PixelFormat = 'rgba8888' | 'yuv420' | 'grayscale' | 'nv21';

export type LensFacing = 'back' | 'front' | 'external';

export interface CapturedFrameMetadata {
  /** Monotonic hardware acquisition timestamp in nanoseconds */
  readonly sensorTimestampNs: number;
  /** Camera exposure time in nanoseconds, if exposed by platform HAL */
  readonly exposureTimeNs?: number | undefined;
  /** Sensor ISO sensitivity rating, if available */
  readonly iso?: number | undefined;
  /** Lens focus distance in diopters / normalized units, if available */
  readonly focusDistance?: number | undefined;
  /** Image sensor orientation relative to natural device orientation (0, 90, 180, 270) */
  readonly rotationDegrees: number;
  /** Camera facing direction */
  readonly lensFacing?: LensFacing | undefined;
  /** Platform-specific extra parameters (e.g., color temperature, lux) */
  readonly extra?: Record<string, string | number | boolean> | undefined;
}

/**
 * Representation of a single optical frame captured from a camera sensor.
 * Strictly decoupled from Android/iOS platform classes.
 */
export interface CapturedFrame {
  /** Monotonically increasing sequential frame counter from camera start */
  readonly sequenceNumber: number;
  /** Wall-clock acquisition timestamp in milliseconds */
  readonly timestampMs: number;
  /** Width in pixels */
  readonly width: number;
  /** Height in pixels */
  readonly height: number;
  /** Color/pixel format of the raw frame data */
  readonly pixelFormat: PixelFormat;
  /** Raw pixel data buffer */
  readonly data: Uint8Array | Uint8ClampedArray;
  /** Optical capture metadata */
  readonly metadata: CapturedFrameMetadata;
  /** Converts or wraps frame data into a standardized RGBA PixelBuffer */
  toPixelBuffer(): PixelBuffer;
}

/**
 * Source of optical frames (e.g. physical camera stream, video feed, or simulated channel).
 */
export interface OpticalFrameSource {
  readonly isActive: boolean;
  start(onFrame: (frame: CapturedFrame) => void): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Sink for visual frames (e.g. physical screen display, monitor, or test renderer).
 */
export interface OpticalFrameSink {
  displayFrame(frame: VisualFrame): Promise<void>;
  clear(): Promise<void>;
}

// ============================================================================
// Three-Tier Duplicate Classification Model
// ============================================================================

export type DuplicateClassification =
  | 'novel' // First arrival of visual payload and transport packet
  | 'camera_duplicate' // Camera sensor sampled the display faster than screen refresh (identical pixel/module data)
  | 'frame_repetition' // Sender deliberately repeated visual frame for redundancy (different camera tick, same visual frame)
  | 'packet_duplicate'; // Novel optical frame, but transport packet sequence already received (fountain duplicate)

export interface FrameProcessingResult {
  readonly frameSequence: number;
  readonly qrDetected: boolean;
  readonly decodeLatencyMs: number;
  readonly classification: DuplicateClassification;
  readonly payloadBytes?: number | undefined;
  readonly qrVersion?: number | undefined;
  readonly eccLevel?: string | undefined;
  readonly packetIdentifier?: string | undefined; // e.g. "sessionId:blockIndex:symbolId"
  readonly error?: string | undefined;
}

// ============================================================================
// Multi-Level Optical Channel Metrics
// ============================================================================

export interface OpticalChannelMetricsSnapshot {
  // --- Raw Physical Frame Metrics ---
  readonly totalFramesReceived: number;
  readonly totalFramesDropped: number;
  readonly observedFps: number;
  readonly meanFrameIntervalMs: number;
  readonly frameIntervalJitterMs: number;

  // --- Visual QR Detection Metrics ---
  readonly totalQrFramesDetected: number;
  readonly totalQrDecodeFailures: number;
  readonly qrDetectionRate: number; // detected / received
  readonly meanDecodeLatencyMs: number;

  // --- Duplicate Analysis Metrics ---
  readonly cameraFrameDuplicates: number;
  readonly visualFrameRepetitions: number;
  readonly transportPacketDuplicates: number;
  readonly uniquePacketsDelivered: number;

  // --- Three Distinct Performance Layers ---
  /** LEVEL 1: Pure QR Software Codec Throughput (bytes/sec) */
  readonly level1CodecThroughputBps: number;
  /** LEVEL 2: Physical Optical Channel Effective Goodput (bytes/sec) */
  readonly level2OpticalGoodputBps: number;
  /** LEVEL 3: End-to-End Verified Transfer Goodput (verified bytes / total elapsed time) */
  readonly level3EndToEndGoodputBps: number;

  readonly elapsedDurationMs: number;
}

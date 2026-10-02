import type { VisualFrame } from '../visual/types.js';
import type { CapturedFrame, OpticalFrameSource, PixelFormat } from './types.js';
import { createCapturedFrame } from './frame.js';

export interface OpticalSimulatorOptions {
  /** Display screen refresh rate in Hz (default: 30) */
  readonly displayRefreshHz?: number | undefined;
  /** Camera sensor capture frame rate in FPS (default: 30) */
  readonly cameraCaptureFps?: number | undefined;
  /** Number of display refresh cycles each visual frame is shown (default: 1) */
  readonly repetitionCount?: number | undefined;
  /** Frame drop probability due to optical occlusion / out-of-frame (0.0 to 1.0, default: 0) */
  readonly dropRate?: number | undefined;
  /** Timing jitter standard deviation in milliseconds (default: 0) */
  readonly jitterMs?: number | undefined;
  /** Glare / specular reflection corruption probability (0.0 to 1.0, default: 0) */
  readonly glareRate?: number | undefined;
  /** Output pixel format for simulated frames (default: 'rgba8888') */
  readonly pixelFormat?: PixelFormat | undefined;
  /** Deterministic PRNG seed for reproducible test results */
  readonly seed?: number | undefined;
}

/**
 * Deterministic software simulator for the screen-to-camera optical channel.
 *
 * Models:
 * - Display refresh vs Camera sampling rate differences (e.g. 15 Hz screen vs 60 FPS camera)
 * - Controlled visual frame repetitions (A, A, B, B, C, C)
 * - Hardware interval jitter
 * - Optical path packet drops (occlusion)
 * - Optical glare/contrast degradation
 *
 * Implements OpticalFrameSource and provides synchronous simulation for CI tests.
 */
export class PhysicalOpticalChannelSimulator implements OpticalFrameSource {
  readonly displayRefreshHz: number;
  readonly cameraCaptureFps: number;
  readonly repetitionCount: number;
  readonly dropRate: number;
  readonly jitterMs: number;
  readonly glareRate: number;
  readonly pixelFormat: PixelFormat;

  private active = false;
  private timerId?: ReturnType<typeof setTimeout> | undefined;
  private prngState: number;

  constructor(options?: OpticalSimulatorOptions) {
    this.displayRefreshHz = options?.displayRefreshHz ?? 30;
    this.cameraCaptureFps = options?.cameraCaptureFps ?? 30;
    this.repetitionCount = options?.repetitionCount ?? 1;
    this.dropRate = options?.dropRate ?? 0;
    this.jitterMs = options?.jitterMs ?? 0;
    this.glareRate = options?.glareRate ?? 0;
    this.pixelFormat = options?.pixelFormat ?? 'rgba8888';
    this.prngState = options?.seed ?? 123456789;
  }

  get isActive(): boolean {
    return this.active;
  }

  /**
   * Deterministic pseudo-random number generator (Mulberry32).
   */
  private nextRandom(): number {
    let t = (this.prngState += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Synchronously generates the complete sequence of captured camera frames
   * resulting from displaying a series of visual frames over the optical channel.
   * Ideal for fast, deterministic unit and integration tests in CI.
   */
  generateFrames(visualFrames: VisualFrame[], startClockMs: number = 1000): CapturedFrame[] {
    if (visualFrames.length === 0) {
      return [];
    }

    const capturedFrames: CapturedFrame[] = [];
    const displayIntervalMs = 1000 / this.displayRefreshHz;
    const cameraIntervalMs = 1000 / this.cameraCaptureFps;

    // Total display duration per visual frame = displayIntervalMs * repetitionCount
    const frameHoldDurationMs = displayIntervalMs * this.repetitionCount;
    const totalDurationMs = visualFrames.length * frameHoldDurationMs;

    let cameraClockMs = startClockMs;
    let sequenceNumber = 1;

    while (cameraClockMs < startClockMs + totalDurationMs - cameraIntervalMs * 0.1) {
      // Determine which visual frame is currently active on the screen at this timestamp
      const elapsedMs = cameraClockMs - startClockMs;
      const visualFrameIndex = Math.min(
        visualFrames.length - 1,
        Math.floor(elapsedMs / frameHoldDurationMs),
      );
      const activeVisualFrame = visualFrames[visualFrameIndex]!;

      // Simulate optical occlusion / drop
      const isDropped = this.dropRate > 0 && this.nextRandom() < this.dropRate;

      if (!isDropped) {
        // Simulate interval jitter
        const jitter = this.jitterMs > 0 ? (this.nextRandom() * 2 - 1) * this.jitterMs : 0;
        const actualTimestampMs = Math.round(cameraClockMs + jitter);

        // Simulate glare / pixel corruption if triggered
        const hasGlare = this.glareRate > 0 && this.nextRandom() < this.glareRate;
        const frameData = this.prepareFrameData(activeVisualFrame, hasGlare, this.pixelFormat);

        const captured = createCapturedFrame({
          sequenceNumber: sequenceNumber++,
          timestampMs: actualTimestampMs,
          width: activeVisualFrame.pixelBuffer.width,
          height: activeVisualFrame.pixelBuffer.height,
          pixelFormat: this.pixelFormat,
          data: frameData,
          metadata: {
            sensorTimestampNs: actualTimestampMs * 1_000_000,
            rotationDegrees: 0,
            lensFacing: 'back',
            extra: {
              activeVisualIndex: visualFrameIndex,
              hasGlare,
            },
          },
        });

        capturedFrames.push(captured);
      }

      cameraClockMs += cameraIntervalMs;
    }

    return capturedFrames;
  }

  /**
   * Prepares pixel buffer data in the desired pixel format, applying glare if simulated.
   */
  private prepareFrameData(
    frame: VisualFrame,
    hasGlare: boolean,
    format: PixelFormat,
  ): Uint8Array | Uint8ClampedArray {
    const rawRgba = frame.pixelBuffer.data;
    const width = frame.pixelBuffer.width;
    const height = frame.pixelBuffer.height;

    // Clone data to avoid mutating the original VisualFrame
    const rgbaCopy = new Uint8ClampedArray(rawRgba.length);
    rgbaCopy.set(rawRgba);

    if (hasGlare) {
      // Corrupt a rectangular region simulating specular screen glare
      const glareStartX = Math.floor(width * 0.2);
      const glareEndX = Math.floor(width * 0.8);
      const glareStartY = Math.floor(height * 0.2);
      const glareEndY = Math.floor(height * 0.8);

      for (let y = glareStartY; y < glareEndY; y++) {
        for (let x = glareStartX; x < glareEndX; x++) {
          const idx = (y * width + x) * 4;
          rgbaCopy[idx] = 255; // Whiteout glare
          rgbaCopy[idx + 1] = 255;
          rgbaCopy[idx + 2] = 255;
          rgbaCopy[idx + 3] = 255;
        }
      }
    }

    if (format === 'rgba8888') {
      return rgbaCopy;
    }

    if (format === 'grayscale') {
      const gray = new Uint8Array(width * height);
      for (let i = 0; i < width * height; i++) {
        const offset = i * 4;
        // Standard Rec. 601 luma: Y = 0.299R + 0.587G + 0.114B
        gray[i] = Math.round(
          0.299 * rgbaCopy[offset]! + 0.587 * rgbaCopy[offset + 1]! + 0.114 * rgbaCopy[offset + 2]!,
        );
      }
      return gray;
    }

    if (format === 'yuv420' || format === 'nv21') {
      // Y plane followed by subsampled UV plane
      const ySize = width * height;
      const uvSize = Math.floor(ySize / 2);
      const yuv = new Uint8Array(ySize + uvSize);
      for (let i = 0; i < ySize; i++) {
        const offset = i * 4;
        yuv[i] = Math.round(
          0.299 * rgbaCopy[offset]! + 0.587 * rgbaCopy[offset + 1]! + 0.114 * rgbaCopy[offset + 2]!,
        );
      }
      // Fill UV with neutral 128
      yuv.fill(128, ySize);
      return yuv;
    }

    return rgbaCopy;
  }

  /**
   * Starts asynchronous streaming simulation (if needed for real-time tests).
   */
  async start(_onFrame: (frame: CapturedFrame) => void): Promise<void> {
    this.active = true;
  }

  async stop(): Promise<void> {
    this.active = false;
    if (this.timerId !== undefined) {
      clearTimeout(this.timerId);
      this.timerId = undefined;
    }
  }
}

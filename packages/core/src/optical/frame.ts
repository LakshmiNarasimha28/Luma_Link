import type { PixelBuffer } from '../visual/types.js';
import type { CapturedFrame, CapturedFrameMetadata, PixelFormat } from './types.js';

export interface CreateCapturedFrameOptions {
  sequenceNumber: number;
  timestampMs?: number;
  width: number;
  height: number;
  pixelFormat: PixelFormat;
  data: Uint8Array | Uint8ClampedArray;
  metadata?: Partial<CapturedFrameMetadata>;
}

/**
 * Concrete implementation of CapturedFrame.
 * Provides zero-copy or efficient conversion to RGBA PixelBuffer for visual decoders.
 */
export class DefaultCapturedFrame implements CapturedFrame {
  readonly sequenceNumber: number;
  readonly timestampMs: number;
  readonly width: number;
  readonly height: number;
  readonly pixelFormat: PixelFormat;
  readonly data: Uint8Array | Uint8ClampedArray;
  readonly metadata: CapturedFrameMetadata;

  private cachedPixelBuffer?: PixelBuffer;

  constructor(options: CreateCapturedFrameOptions) {
    this.sequenceNumber = options.sequenceNumber;
    this.timestampMs = options.timestampMs ?? Date.now();
    this.width = options.width;
    this.height = options.height;
    this.pixelFormat = options.pixelFormat;
    this.data = options.data;

    this.metadata = {
      sensorTimestampNs: options.metadata?.sensorTimestampNs ?? this.timestampMs * 1_000_000,
      exposureTimeNs: options.metadata?.exposureTimeNs,
      iso: options.metadata?.iso,
      focusDistance: options.metadata?.focusDistance,
      rotationDegrees: options.metadata?.rotationDegrees ?? 0,
      lensFacing: options.metadata?.lensFacing ?? 'back',
      extra: options.metadata?.extra,
    };
  }

  toPixelBuffer(): PixelBuffer {
    if (this.cachedPixelBuffer) {
      return this.cachedPixelBuffer;
    }

    let rgbaBuffer: Uint8ClampedArray | Uint8Array;

    switch (this.pixelFormat) {
      case 'rgba8888': {
        rgbaBuffer = this.data;
        break;
      }

      case 'grayscale': {
        // Luminance Y channel: 1 byte per pixel -> Expand to RGBA (4 bytes per pixel)
        const totalPixels = this.width * this.height;
        const rgba = new Uint8ClampedArray(totalPixels * 4);
        const src = this.data;
        for (let i = 0; i < totalPixels; i++) {
          const lum = src[i]!;
          const offset = i * 4;
          rgba[offset] = lum;
          rgba[offset + 1] = lum;
          rgba[offset + 2] = lum;
          rgba[offset + 3] = 255;
        }
        rgbaBuffer = rgba;
        break;
      }

      case 'yuv420':
      case 'nv21': {
        // First width * height bytes are luminance (Y plane)
        // For optical QR detection, chrominance (U/V) is unnecessary; Y channel is converted to grayscale RGBA
        const totalPixels = this.width * this.height;
        const rgba = new Uint8ClampedArray(totalPixels * 4);
        const src = this.data;
        for (let i = 0; i < totalPixels; i++) {
          const lum = src[i]!;
          const offset = i * 4;
          rgba[offset] = lum;
          rgba[offset + 1] = lum;
          rgba[offset + 2] = lum;
          rgba[offset + 3] = 255;
        }
        rgbaBuffer = rgba;
        break;
      }

      default: {
        throw new Error(`Unsupported pixel format: ${String(this.pixelFormat)}`);
      }
    }

    this.cachedPixelBuffer = {
      width: this.width,
      height: this.height,
      data: rgbaBuffer,
    };

    return this.cachedPixelBuffer;
  }
}

/**
 * Convenience factory to create a CapturedFrame instance.
 */
export function createCapturedFrame(options: CreateCapturedFrameOptions): CapturedFrame {
  return new DefaultCapturedFrame(options);
}

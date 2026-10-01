/**
 * Visual Codec abstractions and frame models for LumaLink.
 *
 * CRITICAL ARCHITECTURAL PRINCIPLE:
 * QR is a VISUAL CODEC. QR is NOT the transport protocol.
 * The transport, FEC, security, and session layers remain completely independent of the visual codec.
 */

export type VisualCodecType = 'qr' | 'multi-qr' | 'color' | 'custom';

export type EccLevel = 'L' | 'M' | 'Q' | 'H';

export interface VisualCodecOptions {
  /**
   * Error Correction Level:
   * - 'L': ~7% recovery
   * - 'M': ~15% recovery (default)
   * - 'Q': ~25% recovery
   * - 'H': ~30% recovery
   */
  readonly eccLevel?: EccLevel | undefined;
  /** Minimum QR symbol version (1..40) */
  readonly minVersion?: number | undefined;
  /** Maximum allowable QR symbol version (1..40) */
  readonly maxVersion?: number | undefined;
  /** Exact version to force */
  readonly version?: number | undefined;
  /** Pixels per module in rendered pixel buffer (default: 4) */
  readonly scale?: number | undefined;
  /** Quiet zone in modules around the symbol (default: 4) */
  readonly quietZone?: number | undefined;
}

/**
 * 2D binary grid representation of a visual symbol.
 * 1 (true) represents dark / foreground module; 0 (false) represents light / background module.
 */
export interface BitMatrix {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array; // Row-major: data[y * width + x] === 1 for dark
  get(x: number, y: number): boolean;
  set(x: number, y: number, value: boolean): void;
}

/**
 * Raw RGBA pixel buffer representation of a visual frame.
 * 4 bytes per pixel: [R, G, B, A] in row-major order.
 * Compatible with HTML Canvas, headless Node buffers, and mobile camera pixel buffers.
 */
export interface PixelBuffer {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray | Uint8Array;
}

export interface VisualFrameMetadata {
  readonly version: number;
  readonly eccLevel: EccLevel;
  readonly payloadBytes: number;
  readonly moduleDimensions: { readonly width: number; readonly height: number };
  readonly pixelDimensions: { readonly width: number; readonly height: number };
  readonly timestamp?: number | undefined;
}

/**
 * Explicit visual-frame representation separate from the Phase 1 transport packet.
 */
export interface VisualFrame {
  readonly codecType: VisualCodecType;
  readonly matrix: BitMatrix;
  readonly pixelBuffer: PixelBuffer;
  readonly metadata: VisualFrameMetadata;
}

/**
 * Pluggable Visual Codec interface for LumaLink.
 * Agnostic of transport packet headers, FEC symbols, and cryptography.
 */
export interface VisualCodec {
  readonly codecType: VisualCodecType;

  /**
   * Encodes a raw binary payload into a VisualFrame.
   * Preserves binary data as binary (no base64 / hex / JSON conversion).
   */
  encode(payload: Uint8Array, options?: VisualCodecOptions): VisualFrame;

  /**
   * Decodes a visual frame or raw pixel buffer back into raw binary bytes.
   * Throws VisualDecodeError if the frame cannot be parsed or error-corrected.
   */
  decode(frameOrPixels: VisualFrame | PixelBuffer): Uint8Array;

  /**
   * Returns maximum binary payload capacity in bytes for the specified version and ECC level.
   */
  getCapacity(version: number, eccLevel: EccLevel): number;
}

// ============================================================================
// Error Types
// ============================================================================

export class VisualCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisualCodecError';
  }
}

export class VisualCapacityError extends VisualCodecError {
  readonly payloadLength: number;
  readonly maxCapacity: number;

  constructor(payloadLength: number, maxCapacity: number, message?: string) {
    super(
      message ??
        `Payload size (${payloadLength} bytes) exceeds maximum visual codec capacity (${maxCapacity} bytes)`,
    );
    this.name = 'VisualCapacityError';
    this.payloadLength = payloadLength;
    this.maxCapacity = maxCapacity;
  }
}

export class VisualDecodeError extends VisualCodecError {
  constructor(message: string = 'Visual frame could not be decoded or located') {
    super(message);
    this.name = 'VisualDecodeError';
  }
}

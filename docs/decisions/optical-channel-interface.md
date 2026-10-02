# Architecture Decision Record (ADR-007): Optical Channel Interface & Platform Separation

## Status

Accepted

## Context

Phase 4 introduces the physical screen-to-camera optical channel into LumaLink. Mobile platforms (Android, iOS) expose divergent camera frameworks: Android uses CameraX / Camera2, while iOS uses AVFoundation. Furthermore, headless test runners and CI environments possess no physical camera hardware whatsoever.

We must define a clean, minimal abstraction for captured optical frames, acquisition timing, and channel metrics within `@lumalink/core` that:

1. Prevents mobile SDK classes (`android.hardware.*`, `androidx.camera.*`, `AVFoundation`) from leaking into the protocol core;
2. Provides zero-copy or low-overhead format conversions for visual decoders;
3. Enables deterministic software simulations in CI without physical hardware;
4. Tracks high-precision acquisition timestamps and jitter for scientific channel characterization.

## Decision

### 1. Minimal Frame Representation (`CapturedFrame`)

We define `CapturedFrame` in `packages/core/src/optical/types.ts`:

```typescript
export type PixelFormat = 'rgba8888' | 'yuv420' | 'grayscale' | 'nv21';

export interface CapturedFrameMetadata {
  readonly sensorTimestampNs: number;
  readonly exposureTimeNs?: number;
  readonly iso?: number;
  readonly focusDistance?: number;
  readonly rotationDegrees: number;
  readonly lensFacing?: 'back' | 'front' | 'external';
  readonly extra?: Record<string, string | number | boolean>;
}

export interface CapturedFrame {
  readonly sequenceNumber: number;
  readonly timestampMs: number;
  readonly width: number;
  readonly height: number;
  readonly pixelFormat: PixelFormat;
  readonly data: Uint8Array | Uint8ClampedArray;
  readonly metadata: CapturedFrameMetadata;
  toPixelBuffer(): PixelBuffer;
}
```

### 2. Standardized Luminance Plane Extraction

Rather than forcing mobile platforms to convert camera frames to RGBA (which wastes CPU and memory bandwidth on mobile devices), `CapturedFrame` natively supports `'grayscale'` luminance planes.

- For QR decoding, chrominance is ignored.
- When `toPixelBuffer()` is called for JS decoders (like `jsQR`) that require RGBA, it expands the grayscale values $Y \to [Y, Y, Y, 255]$ efficiently.
- On Android, `PlanarYUVLuminanceSource` consumes the Y plane directly with zero memory duplication.

### 3. Metric Aggregation & Three Performance Layers

`OpticalMetricsCollector` calculates:

- Observed FPS and frame interval jitter using sliding-window statistics;
- Detection rates and decode latency;
- Three independent performance layers:
  - **Level 1**: Pure software codec throughput ($B/s$);
  - **Level 2**: Physical optical channel goodput ($B/s$);
  - **Level 3**: End-to-end verified goodput ($B/s$, post SHA-256 verification).

### 4. Deterministic Simulation (`PhysicalOpticalChannelSimulator`)

To guarantee that CI test suites remain deterministic and self-contained, `PhysicalOpticalChannelSimulator` implements `OpticalFrameSource`. It models display refresh rates, camera capture rates, interval jitter, packet drops, and specular glare without requiring physical camera hardware.

## Consequences

### Positive

- `@lumalink/core` remains 100% platform-independent and can run on Node.js, Web, React Native, and desktop runtimes without modification.
- CI tests run in seconds without hardware dependencies or flaky camera mocks.
- Clear separation between physical capture and protocol logic.

### Negative / Tradeoffs

- Format expansion from grayscale to RGBA in TypeScript introduces a minor copy step when using `jsQR`. However, on mobile platform harnesses, pure-Java/Kotlin decoders read the grayscale buffer directly.

## Rejected Alternatives

1. **Directly importing CameraX / AVFoundation into core**: Rejected. Completely destroys cross-platform portability and prevents browser/desktop compilation.
2. **Abstracting the camera as a generic binary byte stream (`ReadableStream<Uint8Array>`)**: Rejected. Obscures critical optical metadata (timestamps, dimensions, exposure, rotation) needed for optical channel characterization and frame timing analysis.
3. **Speculative hardware controls in core**: Rejected. Features like multi-camera stereo depth or infrared sensors were excluded because they are unnecessary for the optical baseline.

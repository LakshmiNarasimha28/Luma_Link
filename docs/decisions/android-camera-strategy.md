# Architecture Decision Record (ADR-008): Android Camera Strategy & Backpressure Architecture

## Status

Accepted

## Context

Phase 4 requires an Android-first camera capture implementation to measure the physical optical channel. Android offers multiple camera APIs:

1. **Camera1 (Deprecated)**: Obsolete, lacks modern HAL3 features.
2. **Camera2**: Low-level HAL control, but highly verbose and prone to device-specific edge cases, device fragmentation, and concurrency pitfalls.
3. **CameraX**: Jetpack library built on top of Camera2. Lifecycle-aware, tested across Google's automated device lab, providing consistent behavior across thousands of Android device models.
4. **Native NDK (Camera2 C / C++)**: Highly complex, introduces native build tooling (CMake, NDK), cross-compilation headaches, and ABI management without proven performance benefits for frame ingestion.

Furthermore, mobile cameras deliver 30 to 60 frames per second. When running software visual decoding (which may take 15–40 ms per frame), a backpressure strategy is mandatory to avoid catastrophic memory accumulation and stale frame processing.

## Decision

### 1. CameraX as Primary Abstraction

We select Google AndroidX CameraX (`1.3.4`) as the primary camera framework for the Android receiver harness:

- `Preview` handles viewfinder rendering efficiently on GPU hardware surfaces.
- `ImageAnalysis` provides zero-copy frame access directly to the CPU.
- Camera lifecycle is tied to Android Activity lifecycles automatically, preventing battery drain and camera lockups.

### 2. Backpressure Strategy: `STRATEGY_KEEP_ONLY_LATEST`

We enforce:

```kotlin
ImageAnalysis.Builder()
    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
    .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888)
    .build()
```

- **Rationale**: In an optical file-transfer channel, processing stale frames that have already transitioned on the screen is detrimental. If a frame decode takes longer than 33 ms, intermediate frames must be discarded at the camera driver level.
- `STRATEGY_KEEP_ONLY_LATEST` guarantees that whenever the analyzer finishes a frame and closes the `ImageProxy`, the camera driver immediately supplies the freshest, most current frame displayed on the screen.
- Memory allocation remains bounded to 1–2 internal image buffers.

### 3. Camera2 Interop Restricted to Experimental Controls

We do NOT implement a raw Camera2 pipeline. Instead, we utilize `Camera2Interop` exclusively to expose manual capture request parameters required for controlled physical experiments:

- Locking Auto-Exposure (`CaptureRequest.CONTROL_AE_LOCK = true`) during high-frequency optical frame transitions to prevent exposure flutter;
- Locking Auto-Focus (`CaptureRequest.CONTROL_AF_MODE = CONTROL_AF_MODE_AUTO`) to prevent focus hunting once the sender screen is in focus.

### 4. Zero Native Dependencies (No C++, No Rust, No ML)

We explicitly reject native C++, Rust, and ML libraries for Phase 4:

- Android harness uses standard pure-Java/Kotlin APIs and pure-Java ZXing (`com.google.zxing:core:3.5.3`).
- Minimizes build complexity and avoids JNI bridging overhead.
- Maintains strict technology accountability: measure baseline performance before introducing native complexity.

### 5. Architectural Separation: Core jsQR vs Platform Android ZXing

Phase 3 established `jsQR` as the core visual codec reference, while Phase 4 Android harness uses pure-Java ZXing (`com.google.zxing:core:3.5.3`). This architectural division is intentional and grounded in the following design decisions:

1. **Why Phase 3 Core Continues to Use jsQR**:
   `@lumalink/core` is a pure TypeScript/JavaScript library designed to run on Node.js (headless server/CI), Web browsers, and desktop JS runtimes without Android SDK or native build toolchains. `jsQR` provides a zero-dependency, pure-JS reference decoder that validates the protocol pipeline deterministically across all operating systems.

2. **Why Android Physical Harness Uses ZXing**:
   Android camera frames are captured in the JVM/ART execution environment. Running `jsQR` on Android would require hosting a hidden WebView or bridging raw YUV frames across a JavaScript runtime (e.g. V8 or Hermes), introducing severe memory copies and garbage collection pressure. ZXing runs directly on the ART VM and decodes CameraX buffers in-process.

3. **Why ZXing is Appropriate for Camera Frames**:
   ZXing's `PlanarYUVLuminanceSource` and `HybridBinarizer` are specifically optimized for raw camera sensor luminance planes with non-uniform lighting, shadows, and angle skew. It consumes the $Y$-plane directly with zero color space conversion overhead.

4. **Harness Dependency vs Eventual Production Decoder**:
   In Phase 4, ZXing is strictly a **platform measurement harness dependency** to measure and characterize the physical optical channel. It establishes the baseline. If future phases with 60 Hz or dense QR versions demonstrate that pure-Java decoding is a bottleneck, native acceleration can be evaluated with concrete profiling data.

5. **Payload Representation Parity**:
   Both `jsQR` and ZXing implement the ISO/IEC 18004 standard for 8-bit byte mode. Both return identical binary byte arrays for any given symbol, guaranteeing 100% wire-format interoperability.

6. **Cross-Decoder Benchmark Comparability**:
   `jsQR` and ZXing microbenchmarks measure Level 1 (software codec speed) on different runtime engines (V8 vs ART). While their decoded output is identical, their CPU latencies reflect their respective VM runtimes. However, Level 2 (optical goodput) and Level 3 (verified goodput) are governed by the physical display refresh rate and camera capture interval, making them completely independent of which conforming decoder is used.

7. **Independence of the VisualCodec Abstraction**:
   Neither `jsQR` nor `ZXing` is coupled to the LumaLink transport protocol, AEAD security, or LT fountain codes. The `VisualCodec` abstraction in `@lumalink/core` defines a clean interface (`encode`, `decode`, `getCapacity`), allowing platform adapters to plug in any conforming decoder without modifying the protocol core.

## Consequences

### Positive

- Works reliably across diverse Android vendors (Samsung, Pixel, Xiaomi, OnePlus) without vendor-specific camera HAL workarounds.
- Predictable, bounded memory profile under prolonged high-FPS optical transmission.
- Simple, transparent build with standard Gradle and Android SDK.
- Zero native binaries, zero Rust, zero C++, and zero proprietary ML dependencies.

### Negative / Tradeoffs

- Pure Java QR decoding is slower than a hypothetical highly-optimized SIMD C++ decoder. However, at 15–20 Hz display refresh rates, pure Java decoding comfortably finishes within 8–25 ms, perfectly matching the required channel bandwidth. If future phases demand 60 Hz transfers, native acceleration can be evaluated with concrete data.

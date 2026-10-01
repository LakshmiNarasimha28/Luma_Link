# ADR-001: Initial Technology Stack Selection

## Status

Accepted

## Date

2026-10-01

## Context

LumaLink requires an architecture capable of running complex file-transfer, protocol serialization, forward error correction (FEC), and cryptographic operations across diverse environments. The long-term deployment target includes cross-platform mobile devices (Android and iOS) alongside command-line tools, simulation harnesses, and desktop testing environments.

Selecting an initial technology stack requires balancing:

1. Cross-platform code sharing across mobile and desktop runtimes.
2. Rapid development velocity and iteration speed during early protocol design phases.
3. Testability and decoupling of core logic from native OS peripherals.
4. Maintainability, developer familiarity, and long-term defensibility.
5. High performance where necessary, while avoiding premature optimization and integration complexity.

## Decision

The project adopts the following multi-tier technology stack:

1. **TypeScript (`@lumalink/core`)**:
   - Used for all protocol abstractions, transport packet codecs, session state machines, FEC interfaces, and end-to-end file reassembly logic.
   - Designed to run in standard Node.js environments and within mobile JavaScript engines (Hermes) without modification.

2. **React Native (`apps/mobile`)**:
   - Used for cross-platform mobile user interfaces, device lifecycle handling, and orchestration.
   - Directly imports and executes `@lumalink/core`.

3. **Native Mobile APIs (Android / Kotlin, iOS / Swift)**:
   - Reserved strictly for hardware-dependent bottlenecks where high performance or direct hardware access is mandatory:
     - Real-time camera capture pipelines (Android CameraX, iOS AVFoundation).
     - Low-latency screen frame rendering.
     - Platform-native secure enclave storage if required.

4. **Python (`research/`)**:
   - Used for mathematical research, optical channel modeling, synthetic noise generation, fountain code benchmark evaluations, and data science/ML experiments.

5. **Exclusion of Rust from Initial Production Stack**:
   - Rust is explicitly excluded from the initial phase and will not be introduced into production code at this time.

## Alternatives Considered & Trade-offs

### Option A: Rust Core with C/FFI or UniFFI Bindings to React Native / Mobile

- **Evaluation**: Rust provides zero-cost abstractions, memory safety, and high computational performance. It is well-suited for heavy computational tasks such as advanced matrix-based FEC decoding (e.g. RaptorQ).
- **Why Not Selected for Initial Stack**:
  - Introducing Rust early introduces substantial toolchain complexity: cross-compilation toolchains for multiple mobile architectures (`arm64-v8a`, `armeabi-v7a`, `x86_64`, iOS devices, and iOS simulators).
  - Foreign Function Interface (FFI) bindings (JNI, C-FFI, React Native TurboModules) introduce integration overhead, serialization boundaries, and debugging friction during early protocol iteration.
  - Development velocity for protocol modeling and session orchestration is significantly higher in pure TypeScript.
  - TypeScript code can be profiled first. If and when specific computational bottlenecks (e.g., intensive FEC symbol arithmetic or high-throughput computer vision decoders) are proven by benchmarks to require native performance, targeted native modules (in Rust or C++) can be introduced with empirical justification.

### Option B: Pure Native Development (Separate Swift and Kotlin Codebases)

- **Evaluation**: Building two separate implementations provides optimal native API integration but doubles the maintenance burden, increases the probability of protocol divergence, and complicates testing.
- **Why Not Selected**:
  - The protocol, packet framing, and state machines must remain strictly bit-identical across sender and receiver regardless of platform. A single shared TypeScript core ensures single-source-of-truth behavior.

### Option C: Pure Web / Electron

- **Evaluation**: Useful for desktop testing, but lacks native mobile camera sensor controls (fixed focus, exposure locking, 60fps video capture) essential for optical link quality.

## Consequences

### Positive

- **Single Source of Truth**: Protocol rules, packet formats, and session lifecycles are written once in TypeScript and shared everywhere.
- **Independent Testability**: Core logic can be unit-tested in seconds using Node.js and Vitest without starting mobile simulators or devices.
- **High Velocity**: Rapid prototyping and iteration of protocol schemas and interfaces.
- **Disciplined Evolution**: Performance optimizations are deferred until profiling identifies concrete bottlenecks, keeping the project maintainable and defensible.

### Negative / Trade-offs

- Pure JavaScript/TypeScript execution for compute-intensive tasks (e.g., millions of Galois field arithmetic operations in dense FEC) will have higher CPU overhead than compiled native code.
- Mitigation: FEC interfaces are pluggable by design. If profiling demonstrates that TypeScript cannot meet throughput targets, the FEC engine can be moved to a native module or compiled WebAssembly/Rust module later without altering the rest of the application.

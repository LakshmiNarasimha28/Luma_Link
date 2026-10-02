# LumaLink Architecture — Phase 4: Optical Channel & Screen-to-Camera Capture

## 1. Executive Summary

Phase 4 introduces the real, physical screen-to-camera optical channel into LumaLink. While Phase 3 established the software-only visual codec baseline (generating and decoding synthetic QR pixel buffers in memory), Phase 4 characterizes visible-light transmission through an optical air-gap:

```
Sender Application
       ↓
TransportPacket
       ↓
VisualPacketCodec
       ↓
QrVisualCodec
       ↓
Physical Display Screen
       ↓
Visible-Light Optical Path (Air-gap, Distance, Angle, Ambient Light)
       ↓
Physical Camera Lens & Sensor
       ↓
Captured Image Frame (YUV / Luminance Buffer)
       ↓
QrVisualCodec / Pure-Java Reader
       ↓
OpticalFrameDeduplicator
       ↓
TransportPacket
       ↓
AEAD Decryption / Session Layer
       ↓
Fountain Peeling Decoder
       ↓
SHA-256 Verified File
```

The primary objective of Phase 4 is not to ship a finalized consumer user experience. The objective is to **establish, measure, and characterize the real optical channel**, quantifying the physical bottlenecks that govern optical file transfer.

---

## 2. Fundamental Architectural Invariant

> **CRITICAL INVARIANT**:  
> **QR is a VISUAL CODEC. QR is NOT the transport protocol.**

The LumaLink protocol core (`@lumalink/core`) remains completely decoupled from physical display screens, mobile camera HALs, and QR-specific logic:

```
               +----------------------------------------+
               |             LumaLink Core              |
               |                                        |
               |  File -> Blocker -> LT FEC -> AEAD    |
               |       -> Transport Packet              |
               +-------------------+--------------------+
                                   |
         +-------------------------+-------------------------+
         |                                                   |
         v                                                   v
+------------------+                               +--------------------+
|   Visual Codec   |                               |  Optical Channel   |
| (QrVisualCodec)  |                               |    Abstractions    |
+--------+---------+                               +---------+----------+
         |                                                   |
         +-------------------------+-------------------------+
                                   |
                                   v
                      +-------------------------+
                      |    Platform Adapter     |
                      |  (Android CameraX / UI) |
                      +-------------------------+
```

The optical layer is fully replaceable without touching the transport, session security, fountain codes, or file reassembly engine.

---

## 3. Platform Boundary & Separation

To guarantee long-term multi-platform maintainability:

1. **Core Library (`@lumalink/core`)**: Contains zero Android SDK classes (`android.*`), zero camera hardware types, and zero native binaries. It exposes pure TypeScript/JavaScript interfaces (`CapturedFrame`, `OpticalFrameSource`, `OpticalFrameSink`, `OpticalMetricsCollector`, `OpticalFrameDeduplicator`).
2. **Platform Layer (`apps/android-harness`)**: Implements Android-specific integration using Google Jetpack CameraX (`ImageAnalysis`), Android Surface/View rendering, and pure-Java decoding.
3. **Simulation Layer (`PhysicalOpticalChannelSimulator`)**: Exists in `@lumalink/core` to enable 100% deterministic, high-speed software testing in CI without requiring connected camera hardware.

---

## 4. Camera Pipeline & Android-First Strategy

### 4.1 CameraX as Primary Abstraction

The Android receiver harness utilizes Android CameraX (`1.3.4`) via `ImageAnalysis`. CameraX provides lifecycle-aware session management across diverse Android device vendors without vendor-specific HAL fragmentation.

### 4.2 Non-Blocking Backpressure (`STRATEGY_KEEP_ONLY_LATEST`)

A naive camera pipeline queues incoming frames in memory. When QR decoding takes 25–40 ms on a 60 FPS camera feed, an unbounded queue causes:

- Memory bloat and GC churn;
- Stale frame accumulation (the receiver decodes frames that left the screen seconds ago);
- Latency death spiral.

LumaLink enforces `ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST`. The camera pipeline delivers the newest completed frame and drops intermediate frames at the HAL layer while analysis is active. Once analysis completes and the image buffer is closed, the newest fresh frame is immediately processed.

### 4.3 Zero-Copy Luminance Extraction

Android cameras output `YUV_420_888`. Because QR barcodes rely entirely on spatial luminance contrast, chrominance ($U$ and $V$) planes are superfluous. The harness extracts only the $Y$ plane ($1 \text{ byte/pixel}$):

- Avoids costly $YUV \to RGB$ color conversion;
- Directly feeds grayscale pixels into the QR binarizer;
- Reduces memory bandwidth by 75% compared to full RGBA buffers.

### 4.4 Camera2 Interop Policy

Camera2 interop is restricted strictly to controls unexposed by CameraX:

- **Auto-Exposure Lock (`CONTROL_AE_LOCK`)**: Prevents exposure hunting caused by rapidly flashing high-contrast QR patterns.
- **Auto-Focus Lock (`CONTROL_AF_MODE`)**: Locks lens focus distance once target screen is calibrated, preventing focus oscillation.

---

## 5. Sender Display Pipeline

The sender display harness controls visual presentation parameters:

- **Refresh Intervals**: 33 ms (30 Hz), 50 ms (20 Hz), 66 ms (15 Hz), 100 ms (10 Hz).
- **Repetition Factor ($R$)**: Each visual frame is held on screen for $R$ consecutive refresh ticks ($R \in \{1, 2, 3\}$).
- **Module Scaling**: Controls rendered pixels per QR module ($px/mod \ge 4$) to preserve camera readability across practical distances.
- **Brightness Override**: Forces `window.attributes.screenBrightness = 1.0` to maximize signal-to-noise ratio.

---

## 6. Timing & Asynchronous Oversampling Model

The screen-to-camera optical channel is inherently asynchronous. The receiver **must never assume** that a frame displayed once is captured exactly once:

- When display refresh is 15 Hz (66.6 ms) and camera capture is 30 FPS (33.3 ms), the camera samples each visual frame twice ($A, A, B, B, C, C$).
- When display refresh is 30 Hz and camera capture is 20 FPS, frames may be missed ($A, C, D$).

```
Display (15 Hz): |--- Frame A ---|--- Frame B ---|--- Frame C ---|
Camera (30 FPS):  ^     ^         ^     ^         ^     ^
Captured:         A     A         B     B         C     C
Classification:   Novel CamDup    Novel CamDup    Novel CamDup
```

---

## 7. Three-Tier Duplicate Frame Model

To prevent duplicate optical samples from polluting protocol layers, LumaLink implements a three-tier deduplicator:

| Tier                    | Cause                                                              | Detection Mechanism                                                             | Resolution                                                 |
| :---------------------- | :----------------------------------------------------------------- | :------------------------------------------------------------------------------ | :--------------------------------------------------------- |
| **1. Camera Duplicate** | Camera sensor oversamples screen ($FPS_{cam} > Hz_{disp}$)         | Byte payload matches previous frame AND arrival $\Delta t \le \tau_{threshold}$ | Dropped at optical layer; recorded in optical metrics      |
| **2. Frame Repetition** | Sender intentionally repeats visual frame ($R > 1$) for robustness | Byte payload matches previous frame, but arrival $\Delta t > \tau_{threshold}$  | Counted as repetition; bypasses duplicate decode overhead  |
| **3. Packet Duplicate** | Novel visual frame containing previously decoded fountain symbol   | Decoded packet ID (`sessionId:block:symbol`) matches seen set                   | Dropped before fountain solver; counted in channel metrics |

---

## 8. Layered Optical Error Model

LumaLink manages optical channel impairments through an 8-layer error containment hierarchy:

```
[Layer 1] Physical Optical Degradation (Blur, Distance, Glare, Occlusion)
    ↓
[Layer 2] Camera Hardware / HAL (CameraX Keep-Only-Latest drops stale frames)
    ↓
[Layer 3] QR Reed-Solomon ECC (Corrects up to 15%–30% local symbol damage)
    ↓
[Layer 4] Transport Packet Validation (CRC-32 checksum rejects corruption)
    ↓
[Layer 5] Session AEAD Authentication (ChaCha20-Poly1305 rejects tampering)
    ↓
[Layer 6] Three-Tier Deduplication (Filters camera & packet duplicates)
    ↓
[Layer 7] Luby Transform Fountain Peeling (Absorbs arbitrary frame drops)
    ↓
[Layer 8] SHA-256 Digest Verification (Verifies byte-level file integrity)
```

If optical noise or motion blur exceeds QR Reed-Solomon capacity, the frame fails decode and is silently dropped. The receiver's LT fountain decoder seamlessly absorbs the dropped packet from subsequent symbols without requiring retransmission requests.

---

## 9. Three Performance Layers

Performance metrics must maintain strict distinction between software processing, raw optical packet delivery, and verified application file throughput:

1. **LEVEL 1: QR Software Codec Throughput ($B/s$)**  
   $$\text{Level 1} = \frac{\sum B_{\text{decoded}}}{\sum \frac{t_{\text{decodeCPU}}}{1000}}$$
   - **Numerator**: All raw decoded QR payload bytes (TransportPacket wire bytes, including novel and repeated frames).
   - **Denominator**: Cumulative CPU time spent exclusively inside the QR decode algorithm.
   - **Scope**: Pure software algorithmic speed in memory (typically 20,000–45,000 B/s on modern CPU/ART).

2. **LEVEL 2: Physical Optical Channel Goodput ($B/s$)**  
   $$\text{Level 2} = \frac{\sum_{k \in \text{Novel}} B_{\text{packet}, k}}{\frac{t_{\text{last\_frame}} - t_{\text{first\_frame}}}{1000}}$$
   - **Numerator**: Sum of wire bytes from all **novel** TransportPackets delivered over the optical channel (excludes camera duplicates and frame repetitions; includes packet headers, ciphertext, AEAD tag, and novel fountain symbols).
   - **Denominator**: Total elapsed optical transmission duration from the first captured frame to the final processed frame.
   - **Scope**: Physical air-gap transport capacity, bounded by screen presentation interval and camera capture FPS (typically 2,000–12,000 B/s).

3. **LEVEL 3: End-to-End Verified Goodput ($B/s$)**  
   $$\text{Level 3} = \frac{B_{\text{file}}}{\frac{t_{\text{verified}} - t_{\text{first\_frame}}}{1000}} \quad (\text{only if SHA-256 digest matches})$$
   - **Numerator**: Plaintext application file size in bytes (excludes all transport headers, AEAD tags, and fountain redundancy).
   - **Denominator**: Total wall-clock transfer duration from first frame arrival until final reassembly and SHA-256 verification.
   - **Scope**: The true application-level engineering throughput. Reported strictly after cryptographic verification.

### Mathematical Invariant:

$$\text{Level 3 (Verified File Goodput)} \le \text{Level 2 (Optical Link Goodput)} < \text{Level 1 (Software Codec Speed)}$$
Because $B_{\text{file}} \le \sum B_{\text{packet}}$, and total verification time $\ge$ optical channel active time, Level 3 is strictly bounded by Level 2.

---

## 10. Limitations & Non-Goals

The following technologies are explicitly out of scope for Phase 4:

- Rolling-shutter stripe modulation (future research direction);
- Machine learning / neural network image enhancement;
- Native C++ / Rust dependencies;
- Two-way optical pairing or reverse Wi-Fi backchannels;
- RGB color multiplexed barcodes.

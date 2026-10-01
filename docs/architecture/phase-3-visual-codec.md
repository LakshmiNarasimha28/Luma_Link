# Phase 3: Visual Codec & QR Baseline Architecture

## 1. Executive Summary

Phase 3 introduces the visual modulation and demodulation subsystem for LumaLink. It establishes a software-only visual codec pipeline using ISO/IEC 18004 Quick Response (QR) codes as the baseline codec, operating strictly in 8-bit binary byte mode.

### Core Architectural Principle

$$\text{QR is a VISUAL CODEC. QR is NOT the transport protocol.}$$

The protocol core (session orchestration, key agreement, AEAD encryption, Luby Transform fountain coding, deduplication, and file reassembly) remains decoupled from the visual representation.

---

## 2. End-to-End Visual Pipeline

```text
SENDER PIPELINE
  Source File
      ↓
  FileBlocker (Partition into Source Blocks: K symbols of S bytes)
      ↓
  LtEncoder (Fountain Encoded Symbols: degree + seed + raw payload)
      ↓
  SessionSecurityContext (ChaCha20-Poly1305 AEAD with 26-byte AAD binding)
      ↓
  TransportPacket (Binary serialized wire bytes: 42B Header + 16B Tag + Ciphertext)
      ↓
  VisualPacketCodec (Adapter)
      ↓
  QrVisualCodec (ISO/IEC 18004 8-bit Byte Mode Encoding)
      ↓
  VisualFrame (BitMatrix + RGBA PixelBuffer + Metadata)
      ↓
OPTICAL / SIMULATED CHANNEL (Screen display → Camera capture / Synthetic noise & loss)
      ↓
RECEIVER PIPELINE
  VisualFrame / Raw PixelBuffer
      ↓
  QrVisualCodec.decode (jsQR Reed-Solomon Error Correction & Byte Extraction)
      ↓
  VisualPacketCodec (Binary deserialization → TransportPacket)
      ↓
  PacketDeduplicator (Drop seen sequence pairs)
      ↓
  SessionSecurityContext.decryptPayload (Poly1305 Tag check + ReplayProtector)
      ↓
  LtDecoder (Peeling Decoder graph reconstruction)
      ↓
  FileReassembler (Multi-block assembly)
      ↓
  End-to-End SHA-256 Digest Verification
```

---

## 3. The Layered Error Model

LumaLink employs a defense-in-depth, multi-tier error mitigation model across the visual transfer stack. Each layer addresses a specific physical or logical failure mode without redundant cryptographic machinery:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. VISUAL CHANNEL NOISE & OPTICAL CORRUPTION                                │
│    Mitigation: QR Reed-Solomon Error Correction (Level L: 7%, M: 15%, H: 30%)│
│    Role: Corrects optical blur, pixel distortion, and small physical blocks │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼ (If uncorrectable, frame dropped)
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. TRANSMISSION FRAMING & BIT CORRUPTION                                    │
│    Mitigation: Transport Packet CRC32 Checksum (Phase 1)                     │
│    Role: Fast, low-latency rejection of malformed or truncated bitstreams   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. ACTIVE TAMPERING & SPLICING ATTACKS                                      │
│    Mitigation: ChaCha20-Poly1305 128-bit AEAD Tag with 26-byte AAD Binding  │
│    Role: Guarantees cryptographic authenticity and prevents cross-session   │
│          injection or header tampering                                       │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼ (Corrupted / injected packets discarded)
┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. FRAME DROPS & PACKET LOSS (Airgap optical occlusion / missed frames)     │
│    Mitigation: Luby Transform (LT) Fountain Rateless Erasure Coding         │
│    Role: Reconstructs original source blocks from any arbitrary subset of   │
│          K * overhead symbols without requiring retransmission requests     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 5. END-TO-END FILE INTEGRITY                                                │
│    Mitigation: Cryptographic SHA-256 Digest Verification                    │
│    Role: Verifies whole-file integrity after complete reassembly            │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Core Visual Components

### 4.1 `VisualCodec` Abstraction

Located in [`packages/core/src/visual/types.ts`](file:///c:/Users/laksh/OneDrive/Desktop/Luma_Link/packages/core/src/visual/types.ts):

- Pure TypeScript interface handling binary `Uint8Array` payloads.
- Completely decoupled from transport packet formats.
- Prepares LumaLink for future multi-QR, chromatic (RGB multiplexed), and custom optical matrix codecs.

### 4.2 `QrVisualCodec`

Located in [`packages/core/src/visual/qr-codec.ts`](file:///c:/Users/laksh/OneDrive/Desktop/Luma_Link/packages/core/src/visual/qr-codec.ts):

- Encodes raw binary payloads using `qrcode` in 8-bit byte mode.
- Renders 2D `BitMatrix` and formatted `PixelBuffer` with quiet zone and scaling.
- Decodes image frames using `jsQR`, extracting raw `binaryData: number[]`.
- Performs version capacity checks against official ISO/IEC 18004 limits (Versions 1 to 40, ECC levels L, M, Q, H).

### 4.3 `VisualPacketCodec`

Located in [`packages/core/src/visual/packet-adapter.ts`](file:///c:/Users/laksh/OneDrive/Desktop/Luma_Link/packages/core/src/visual/packet-adapter.ts):

- Bridges `TransportPacket` and `VisualCodec`.
- Supports **Strategy A** (1 packet per visual frame).
- Supports **Strategy B** (N packets packed into 1 visual frame).

### 4.4 `SyntheticDegradation` Suite

Located in [`packages/core/src/visual/synthetic-degradation.ts`](file:///c:/Users/laksh/OneDrive/Desktop/Luma_Link/packages/core/src/visual/synthetic-degradation.ts):

- Controlled numerical simulation for laboratory testing:
  - Salt-and-pepper noise
  - Partial obstruction
  - Box blur (optical defocus)
  - Downsampling/upsampling (distance and low camera resolution)

---

## 5. Benchmark & Capacity Evaluation

_Measured on Node.js v24.21.0 (AMD/Intel x64), software simulation only. NOT optical camera throughput._

### 5.1 QR Codec Scaling (ECC Level M)

| Payload Size   | QR Version | Modules         | Pixel Canvas (4x) | Encode Time | Decode Time |
| :------------- | :--------- | :-------------- | :---------------- | :---------- | :---------- |
| **32 Bytes**   | Version 3  | $29\times 29$   | $148\times 148$   | 0.60 ms     | 3.04 ms     |
| **64 Bytes**   | Version 5  | $37\times 37$   | $180\times 180$   | 0.79 ms     | 4.10 ms     |
| **128 Bytes**  | Version 8  | $49\times 49$   | $228\times 228$   | 1.49 ms     | 6.83 ms     |
| **256 Bytes**  | Version 12 | $65\times 65$   | $292\times 292$   | 2.57 ms     | 11.93 ms    |
| **512 Bytes**  | Version 18 | $89\times 89$   | $388\times 388$   | 3.50 ms     | 15.89 ms    |
| **1024 Bytes** | Version 26 | $121\times 121$ | $516\times 516$   | 13.45 ms    | 61.05 ms    |

### 5.2 ECC Level Trade-offs (256-Byte Payload)

| ECC Level   | Approx Recovery | Version    | Module Grid   | Encode Time | Decode Time |
| :---------- | :-------------- | :--------- | :------------ | :---------- | :---------- |
| **Level L** | ~7%             | Version 10 | $57\times 57$ | 3.58 ms     | 13.86 ms    |
| **Level M** | ~15%            | Version 12 | $65\times 65$ | 4.56 ms     | 19.34 ms    |
| **Level Q** | ~25%            | Version 14 | $73\times 73$ | 5.57 ms     | 24.07 ms    |
| **Level H** | ~30%            | Version 17 | $85\times 85$ | 7.89 ms     | 32.01 ms    |

---

## 6. Synthetic Degradation Resilience Summary

| Degradation Condition          | Level L (~7%)      | Level M (~15%)     | Level H (~30%)     |
| :----------------------------- | :----------------- | :----------------- | :----------------- |
| **Clean (0% Corruption)**      | PASS               | PASS               | PASS               |
| **0.5% Salt-and-Pepper Noise** | PASS               | PASS               | PASS               |
| **1.0% Salt-and-Pepper Noise** | PASS               | PASS               | PASS               |
| **1.5% Salt-and-Pepper Noise** | FAIL (Finder lost) | FAIL (Finder lost) | FAIL (Finder lost) |
| **10% Center Obstruction**     | PASS               | PASS               | PASS               |
| **20% Center Obstruction**     | FAIL (Over budget) | PASS               | PASS               |
| **25% Center Obstruction**     | FAIL (Over budget) | PASS               | PASS               |
| **Light Box Blur (Radius 1)**  | PASS               | PASS               | PASS               |
| **2x Downsample/Upsample**     | PASS               | PASS               | PASS               |

---

## 7. Limitations & Future Optical Phases

1. **Hardware Camera Dynamics**:
   Software testing evaluates static pixel buffers. Real camera optical channels introduce rolling shutter, motion blur, ambient glare, perspective skew, and dynamic auto-focus hunting. These are addressed in Phase 4 and Phase 5.
2. **Display Refresh Sync**:
   In screen-to-camera VLC, frame display rate (e.g. 15–30 FPS) must be synchronized with camera capture to avoid duplicate frame reads. Phase 1 deduplication already handles duplicates safely, but display timing loops will be integrated in mobile applications.
3. **Native Scanning Acceleration**:
   JavaScript decoding via `jsQR` achieves ~15–20 ms per frame in Node.js. Mobile production (Phase 5) will wrap native Apple Vision framework and Android MLKit for 60 FPS hardware-accelerated scanning.

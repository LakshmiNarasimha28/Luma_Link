# ADR-006: QR Baseline Codec & Library Selection

## Status

Accepted

## Date

2026-10-01

## Context

Phase 3 establishes the baseline software-only visual codec for LumaLink using standard ISO/IEC 18004 Quick Response (QR) codes.

We evaluated available QR implementations in the JavaScript / TypeScript ecosystem against strict criteria:

1. **Binary Payload Support**: Must support 8-bit byte mode natively without forced text, UTF-8, or Base64 encoding.
2. **Encoding & Decoding**: Must provide both generation and reading in headless Node.js without native C++ compilation bindings (e.g. `node-gyp`).
3. **QR Versions & ECC**: Must support full version spectrum (Version 1 to 40) and all standard error correction levels (L, M, Q, H).
4. **Maintenance & Footprint**: Lightweight, well-maintained, zero/minimal external dependencies, permissible open-source license (MIT / Apache-2.0).
5. **Portability & Native Migration**: Must run cleanly in Node, browser, and mobile JS runtimes (React Native / Hermes), with a clear path to native hardware camera acceleration (Apple Vision / Android MLKit).

---

## Evaluation of Evaluated Alternatives

| Library                                | Role    | Binary Support                                          | Dep Size            | License    | Evaluation & Decision                                                                                                                     |
| :------------------------------------- | :------ | :------------------------------------------------------ | :------------------ | :--------- | :---------------------------------------------------------------------------------------------------------------------------------------- |
| **`qrcode`** (soldair)                 | Encoder | **Native 8-bit byte mode** via `{ data, mode: 'byte' }` | ~135 KB             | MIT        | **Selected for Encoding**. Industry-standard QR generator; outputs raw `BitMatrix` directly; zero native C++ deps.                        |
| **`jsqr`** (cozmo)                     | Decoder | **Native raw `binaryData: number[]`**                   | ~280 KB (zero deps) | Apache-2.0 | **Selected for Decoding**. Pure JS; operates on raw RGBA pixel arrays; extracts raw byte stream directly without string coercion.         |
| **`@zxing/library`**                   | Both    | Supported                                               | ~11.8 MB            | Apache-2.0 | **Rejected for Phase 3 Core**. Very large dependency bundle (11.8 MB); complex AST/tree-shaking; unnecessary for baseline 2D QR decoding. |
| **`qrcode-generator`** (kazuhikoarase) | Encoder | Limited string byte mode                                | ~550 KB             | MIT        | **Rejected**. Older API requiring string-based byte packing; less ergonomic for typed `Uint8Array`s.                                      |
| **`nayuki-qr-code-generator`**         | Encoder | Excellent byte mode                                     | Single file         | MIT        | **Viable alternative**, but lacks built-in decoder; `qrcode` provided broader ecosystem support and matching types.                       |
| **`rqrr` (Rust Wasm)**                 | Decoder | High speed                                              | Wasm binary         | MIT        | **Strictly Rejected**. Project rules forbid introducing Rust in this phase.                                                               |

---

## Decision

We adopt:

1. **`qrcode`** for QR frame generation in 8-bit byte mode.
2. **`jsqr`** for QR frame reading and Reed-Solomon error correction from RGBA pixel buffers.
3. Both are wrapped inside [`QrVisualCodec`](file:///c:/Users/laksh/OneDrive/Desktop/Luma_Link/packages/core/src/visual/qr-codec.ts), exposing pure `Uint8Array` in/out.

---

## Binary Payload Strategy

- QR Code specification (ISO/IEC 18004) defines 4 primary encoding modes:
  1. Numeric (3.3 bits/char)
  2. Alphanumeric (5.5 bits/char)
  3. **8-bit Byte Mode** (8 bits/char) — Mode indicator `0100b`
  4. Kanji (13 bits/char)
- LumaLink exclusively utilizes **8-bit Byte Mode**:
  - The binary wire bytes of transport packets (including header, flags, and AEAD ciphertext) are passed directly into the byte segment.
  - Zero Base64 or hex expansion overhead is incurred ($0\%$ inflation vs $33\%$ for Base64).

---

## Payload Packing Experiment Results (Strategy A vs. Strategy B)

In benchmark experiments on 16 packets (64-byte payload + 42-byte header + 16-byte tag = 122 bytes/packet):

| Strategy              | Framing Format      | Frames Needed | QR Version | Modules       | Total Encode | Total Decode | Error Blast Radius                           |
| :-------------------- | :------------------ | :------------ | :--------- | :------------ | :----------- | :----------- | :------------------------------------------- |
| **Strategy A (1:1)**  | 1 Packet per Frame  | 16 frames     | Version 7  | $45\times 45$ | 54.0 ms      | 182.8 ms     | **Minimal (1 packet lost if frame fails)**   |
| **Strategy B (2:1)**  | 2 Packets per Frame | 8 frames      | Version 11 | $61\times 61$ | 30.0 ms      | 126.8 ms     | **Moderate (2 packets lost if frame fails)** |
| **Strategy B4 (4:1)** | 4 Packets per Frame | 4 frames      | Version 17 | $85\times 85$ | 38.3 ms      | 123.0 ms     | **High (4 packets lost if frame fails)**     |

### Architectural Conclusion:

- In pure software simulation, Strategy B reduces total frame generation overhead because fewer QR headers/finder patterns are rendered.
- **However, in optical screen-to-camera VLC**, higher-version QR codes ($85\times 85$) require significantly higher camera resolution and suffer much higher frame decode failure rates at distance.
- Furthermore, losing one high-density frame drops multiple packets at once, increasing the fountain overhead required.
- **Baseline Default**: Strategy A (1 packet $\to$ 1 QR frame, Versions 4–8) provides the optimal balance of module size, camera scanning speed, and fountain resilience. Strategy B is retained as an option for high-resolution displays.

---

## Native Platform Migration Strategy (Phase 5)

In Phase 5 (mobile production application):

- On **iOS**: Apple's `Vision` framework (`VNDetectBarcodesRequest`) provides native hardware-accelerated scanning at 60 FPS directly on the GPU/Neural Engine.
- On **Android**: Google `ML Kit Barcode Scanning` or native ZXing C++ provides optimized scanning.
- Because `VisualCodec` is abstracted behind an interface, the mobile app can inject a native `NativeCameraVisualCodec` implementing the identical contract without changing any protocol, security, or transfer code.

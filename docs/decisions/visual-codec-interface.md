# ADR-005: Visual Codec Abstraction & Visual Frame Model

## Status

Accepted

## Date

2026-10-01

## Context

LumaLink transmits data over airgapped optical channels (screen-to-camera). This requires modulating binary data into visual representations (frames) and demodulating captured camera sensor frames back into binary bytes.

A critical architectural invariant is:

$$\text{QR is a VISUAL CODEC. QR is NOT the transport protocol.}$$

The protocol core (session establishment, device authorization, pairwise/broadcast AEAD encryption, Luby Transform fountain coding, deduplication, and file reassembly) must remain strictly decoupled from the physical and visual representation.

In future phases, LumaLink will support:

- Standard monochrome QR codes (Phase 3 baseline)
- Tiled multi-QR frames (displaying multiple QR codes simultaneously on large screens)
- Chromatic / Color QR codes (using RGB channels for 3x multiplexing)
- Custom high-density 2D optical barcodes

Therefore, we must define a clean, transport-independent visual codec abstraction.

---

## Decision

### 1. The `VisualCodec` Contract

We define a minimal, pluggable `VisualCodec` interface in [`packages/core/src/visual/types.ts`](file:///c:/Users/laksh/OneDrive/Desktop/Luma_Link/packages/core/src/visual/types.ts):

```typescript
export interface VisualCodec {
  readonly codecType: VisualCodecType;
  encode(payload: Uint8Array, options?: VisualCodecOptions): VisualFrame;
  decode(frameOrPixels: VisualFrame | PixelBuffer): Uint8Array;
  getCapacity(version: number, eccLevel: EccLevel): number;
}
```

#### Core Design Principles:

1. **Raw Binary Preservation**:
   The input and output are raw `Uint8Array` bytes. No Base64, hex, or JSON encoding is performed. This eliminates serialization bloat (saving 33% overhead compared to Base64).
2. **Transport Agnostic**:
   `VisualCodec` knows nothing about packet headers, block indexes, symbol IDs, or cryptography. It only encodes binary bytes into visual frames and decodes visual frames back to bytes.
3. **Pluggable Architecture**:
   Any visual codec (monochrome QR, color matrix, multi-code grid) implements `VisualCodec` without touching FEC, session, or transport layers.

---

### 2. The Visual Frame Model

We define three distinct layers of representation:

```text
Layer 1: Transport Packet (Phase 1 / Phase 2)
  ├── 42-byte binary header (magic, version, type, flags, sessionId, blockIndex, symbolId, FEC metadata)
  └── Wire payload (16-byte Poly1305 AEAD tag + ChaCha20 ciphertext)
        ↓  (BinaryPacketCodec serialization)
Layer 2: Raw Binary Wire Bytes (Uint8Array)
        ↓  (VisualCodec.encode)
Layer 3: Visual Frame (VisualFrame)
  ├── matrix: BitMatrix (2D logical modules: true=dark, false=light)
  ├── pixelBuffer: PixelBuffer (rendered RGBA pixel buffer with quiet zone and scaling)
  └── metadata: VisualFrameMetadata (version, ECC level, payloadBytes, module & pixel dimensions)
```

#### Pixel Buffer Design (`PixelBuffer`)

- Format: Flat `Uint8ClampedArray` with 4 bytes per pixel (`[R, G, B, A]`) in row-major order.
- Cross-Platform Compatibility: Direct drop-in for HTML5 `<canvas>`, Node.js image buffers, and mobile camera frame buffers (Android `ImageReader` / iOS `AVCaptureVideoDataOutput`).

---

### 3. Transport Packet Adapter (`VisualPacketCodec`)

To decouple the visual codec from transport packet structure, the [`VisualPacketCodec`](file:///c:/Users/laksh/OneDrive/Desktop/Luma_Link/packages/core/src/visual/packet-adapter.ts) adapter mediates between `TransportPacket` and `VisualCodec`:

- **Strategy A (1:1 Mapping)**:
  `encodePacket(packet)` $\to$ serializes single packet via `BinaryPacketCodec` $\to$ encodes to single `VisualFrame`.
- **Strategy B (N:1 Bundling)**:
  `encodePackets(packets[])` $\to$ bundles multiple packets into one `VisualFrame` with length-prefixed binary framing `[Count: uint16] [Len_0: uint16] [Data_0] ...`.

---

## Consequences

### Positive

- Strict separation of concerns: optical modulation can be swapped or upgraded without touching the protocol core.
- Zero Base64/hex inflation.
- Enables synthetic image channel testing and simulation independent of hardware cameras.

### Negative / Trade-offs

- Rendering a pixel buffer for decoding incurs memory allocation ($W \times H \times 4$ bytes per frame), though standard QR sizes ($150\times 150$ to $500\times 500$) require only 90 KB to 1 MB per frame in memory.

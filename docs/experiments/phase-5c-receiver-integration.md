# LumaLink Phase 5C.1 — Android Receiver Protocol Integration

## 1. Executive Summary & Objective

Phase 5C.1 establishes the native Android-side LumaLink protocol receiver boundary. It bridges the physical optical decode layer to a validated in-memory transport packet representation without introducing cryptography, FEC reassembly, or protocol alterations:

```
Physical Monitor Display (Phase 5B Browser Harness)
    │
    ▼ [Airgap Optical Channel]
Android CameraX (720p Y-Plane Luminance Capture, Center ROI)
    │
    ▼ [MultiFormatReader / Pure Java ZXing]
ResultMetadataType.BYTE_SEGMENTS (Exact 8-Bit Byte Mode Stream)
    │
    ▼ [QrBytePayloadExtractor]
Exact Binary LumaLink Wire Bytes (122 Bytes)
    │
    ▼ [LumaPacketCodec]
42-Byte Big-Endian Header Parsing + Length Validation + IEEE 802.3 CRC-32 Validation
    │
    ▼ [Validated Representation]
LumaTransportPacket (Immutable Kotlin Model)
    │
    ▼ [Diagnostic HUD Overlay]
"LUMA | DATA | 122 B | CRC OK | B=0 | SYM=0 | K=16 | D=1"
```

This milestone stops strictly at protocol framing, length, and CRC integrity validation.

---

## 2. QR Decoding & Byte Mode Boundary

### Why `result.rawBytes` is NOT Used

In ZXing, `Result.rawBytes` returns the raw codeword stream directly from the QR decoder (including Reed-Solomon error correction codewords, mode indicators, and character count indicators). For a Version 7 QR symbol with 122 bytes of payload, `result.rawBytes` yields 196 codewords. Treating `rawBytes` as the transport packet results in immediate framing failure and length mismatches.

### Why `result.text` is NOT Used

LumaLink TransportPacket wire payloads contain arbitrary binary data, including encrypted ciphertext and authentication tags with byte values $\ge 0x80$ and $0xFF$. Using `result.text.toByteArray(Charsets.UTF_8)` corrupts binary sequences by replacing invalid UTF-8 byte sequences with Unicode replacement characters (`0xEF, 0xBF, 0xBD`), permanently corrupting the packet and failing CRC validation.

### Authoritative Extraction: `ResultMetadataType.BYTE_SEGMENTS`

In ISO/IEC 18004 8-bit Byte Mode, ZXing places the decoded byte array(s) into the result metadata map under `ResultMetadataType.BYTE_SEGMENTS` (`List<ByteArray>`).

`QrBytePayloadExtractor`:

1. Retrieves `metadata[ResultMetadataType.BYTE_SEGMENTS]`.
2. Concatenates all byte segments in ZXing-provided order into a single `ByteArray`.
3. Returns `null` if `BYTE_SEGMENTS` is absent or empty.
4. Never falls back to `result.text` or `result.rawBytes`.

---

## 3. Wire Format & Header Layout

The packet structure exactly mirrors the canonical TypeScript `BinaryPacketCodec` (42-byte header + payload):

| Offset    | Size | Field              | Encoding / Type                                       | Value in Phase 5B DATA Packet          |
| --------- | ---- | ------------------ | ----------------------------------------------------- | -------------------------------------- |
| `0..3`    | 4    | Magic              | ASCII `'LUMA'` (`0x4C, 0x55, 0x4D, 0x41`)             | `'LUMA'`                               |
| `4`       | 1    | Protocol Version   | uint8                                                 | `1`                                    |
| `5`       | 1    | Packet Type        | uint8 (`1`=MANIFEST, `2`=DATA, `3`=SYNC, `4`=CONTROL) | `2` (DATA)                             |
| `6`       | 1    | Flags              | uint8 (`0x02` = `FLAG_ENCRYPTED`)                     | `2`                                    |
| `7`       | 1    | Reserved           | uint8                                                 | `0`                                    |
| `8..23`   | 16   | Session ID         | Raw 16 bytes (UUID v4)                                | `09e99973-c478-442d-af60-2baf76b1d795` |
| `24..27`  | 4    | Block Index        | Big-Endian uint32 (Kotlin `Long`)                     | `0`                                    |
| `28..31`  | 4    | Symbol ID          | Big-Endian uint32 (Kotlin `Long`)                     | `0`                                    |
| `32..33`  | 2    | K (Source Symbols) | Big-Endian uint16 (Kotlin `Int`)                      | `16`                                   |
| `34..35`  | 2    | Degree             | Big-Endian uint16 (Kotlin `Int`)                      | `1`                                    |
| `36..37`  | 2    | Payload Length     | Big-Endian uint16 (Kotlin `Int`)                      | `80`                                   |
| `38..41`  | 4    | Checksum           | Big-Endian uint32 CRC-32 (Kotlin `Long`)              | `0x0d2f3c6f`                           |
| `42..121` | 80   | Payload            | 16B Poly1305 Tag + 64B Ciphertext                     | Preserved as raw bytes                 |

Total wire packet length: $42 + 80 = 122\text{ bytes}$.

---

## 4. CRC-32 Validation Parity

### Canonical Definition

The authoritative TypeScript implementation computes CRC-32 in two stages:

```typescript
const headerPrefix = raw.subarray(0, 38);
const payload = raw.subarray(42, expectedTotal);
const crc1 = computeCrc32(headerPrefix);
const computedChecksum = computeCrc32(payload, crc1 ^ 0xffffffff);
```

Where `computeCrc32(data, previousCrc = 0)` initializes its internal CRC register with `(previousCrc ^ 0xffffffff) >>> 0`. Because the caller passes `crc1 ^ 0xffffffff`, the two XORs cancel out, making `crc1` the direct initial state for the payload pass.

### Kotlin Parity

`LumaPacketCodec.computeCrc32` implements the identical IEEE 802.3 standard table and chaining semantics:

```kotlin
fun computePacketChecksum(data: ByteArray, payloadLength: Int): Long {
    val crc1 = computeCrc32(data, 0, 38, 0L)
    return computeCrc32(data, PACKET_HEADER_SIZE, payloadLength, crc1 xor 0xFFFFFFFFL)
}
```

This guarantees bit-exact matching with the canonical TypeScript core across all 39 real packets emitted by the Phase 5B sender. Standard `java.util.zip.CRC32` cannot be directly used without re-inverting intermediate registers.

---

## 5. Architectural Responsibility Split

- **TypeScript Core (`@lumalink/core`)**:
  Remains the single canonical reference for protocol specification, wire formats, FEC algorithms, and cryptographic invariants.
- **Android Receiver (`apps/android-harness`)**:
  Native Kotlin implementation of the receiver pipeline, constrained by golden vectors generated directly from TypeScript core fixtures.
- **Zero Protocol Drift**:
  No protocol extensions, custom headers, or alternate serialization formats were introduced.

---

## 6. Verification & Test Coverage

### Automated Unit Tests (`LumaPacketCodecTest.kt`)

35 unit tests (15 new Phase 5C.1 tests + 20 existing harness pipeline tests) pass in `testDebugUnitTest`:

| Requirement               | Test Method                                                                                                                                                                                                                                                                                           | Outcome                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **A. Valid Packet**       | `testValidPhase5bPacket0Parsing`, `testValidPhase5bPacket1Parsing`                                                                                                                                                                                                                                    | Verified all 42 header fields, lengths, indices, and payload preservation.               |
| **B. CRC Corruption**     | `testRejectCorruptedPayloadByte`, `testRejectCorruptedLastPayloadByte`                                                                                                                                                                                                                                | Throws `ChecksumMismatchException` on any modified payload bit.                          |
| **C. Header Corruption**  | `testRejectCorruptedHeaderPrefix`, `testRejectCorruptedSessionIdByte`                                                                                                                                                                                                                                 | Throws `ChecksumMismatchException` when header metadata is altered.                      |
| **D. Bad Magic**          | `testRejectBadMagic`                                                                                                                                                                                                                                                                                  | Throws `MalformedPacketException` on non-'LUMA' magic.                                   |
| **E. Truncation**         | `testRejectTruncatedHeader`, `testRejectTruncatedPayload`                                                                                                                                                                                                                                             | Throws `TruncatedPacketException` on buffers $< 42$ or $< 42 + L$.                       |
| **F. Trailing Bytes**     | `testRejectTrailingDataByDefault`, `testAllowTrailingDataWhenConfigured`                                                                                                                                                                                                                              | Throws `TrailingDataException` when unconfigured; bounds payload when configured.        |
| **G. Length Mismatch**    | `testPayloadLengthMismatch`                                                                                                                                                                                                                                                                           | Throws `TruncatedPacketException` when declared length exceeds buffer.                   |
| **H. Unsigned Bytes**     | `testUnsignedBytesSurviveUnchanged`                                                                                                                                                                                                                                                                   | Tested byte values `0x80`, `0xAA`, `0xFE`, `0xFF`; verified no signed promotion errors.  |
| **I. Big-Endian Parsing** | `testBigEndianFieldParsing`                                                                                                                                                                                                                                                                           | Tested asymmetric uint32/uint16 values (`0x12345678`, `0x89ABCDEF`, `0xFEDC`, `0x4321`). |
| **J. BYTE_SEGMENTS**      | `testExtractNullResult`, `testExtractMissingByteSegments`, `testNeverUseRawBytesWhenByteSegmentsAbsent`, `testNeverUseTextWhenByteSegmentsAbsent`, `testExtractSingleByteSegment`, `testExtractMultipleByteSegmentsConcatenatedInOrder`, `testBinaryBytesGreaterThan0x80SurviveWithoutUtf8Corruption` | Verified strict metadata extraction and zero fallback to text or rawBytes.               |
| **K. Golden Vectors**     | `testGoldenVectorPacket0Parity`, `testGoldenVectorPacket1Parity`                                                                                                                                                                                                                                      | Byte-for-byte equivalence against Phase 5B generated packet fixtures.                    |
| **Version/Type**          | `testRejectUnsupportedProtocolVersion`, `testRejectInvalidPacketType`                                                                                                                                                                                                                                 | Throws `UnsupportedProtocolVersionException`, `InvalidPacketTypeException`.              |

### Repository Verification

- **Android Unit Tests**: `./gradlew testDebugUnitTest` $\to$ **35 passed, 0 failed**.
- **Android Assembly**: `./gradlew assembleDebug` $\to$ **BUILD SUCCESSFUL**.
- **Android Lint**: `./gradlew lintDebug` $\to$ **0 errors**.
- **TypeScript Unit Tests**: `pnpm run test` $\to$ **22 test files, 153 tests passed**.
- **TypeScript Typecheck**: `pnpm run typecheck` $\to$ **0 errors**.
- **TypeScript Lint**: `pnpm run lint` $\to$ **0 warnings/errors**.
- **Formatting**: `pnpm run format:check` $\to$ **Clean**.
- **Monorepo Build**: `pnpm run build` $\to$ **Clean**.

---

## 7. Physical Receiver Validation

### Physical Test Environment

- **Display**: PC Monitor displaying `scripts/display-harness/index.html` (Phase 5B static real packet fixture).
- **Presentation**: ISO/IEC 18004 8-bit Byte Mode Version 7 QR code ($45 \times 45$ modules, ECC Level M, 424px).
- **Physical Device**: Samsung Galaxy M04 (Android 13, CameraX 720p Y-plane capture).
- **Optical Receiver**: `OpticalMeasurementReceiverActivity` with targeting reticle and center ROI ($480 \times 480$).

### Observed Behavior

1. CameraX delivers frames at 30 FPS with decoupled background ZXing decoding.
2. ZXing extracts `ResultMetadataType.BYTE_SEGMENTS` consisting of the exact 122-byte LumaLink wire packet.
3. `LumaPacketCodec.decode()` parses:
   - Magic: `LUMA`
   - Type: `DATA` (2)
   - Size: `122 B` (42B header + 80B payload)
   - CRC: `CRC OK` (`0x0d2f3c6f` matching computed value)
   - Block: `B=0`
   - Symbol: `SYM=0`
   - Source symbols: `K=16`
   - Degree: `D=1`
4. HUD updates live display:
   `Protocol: LUMA | DATA | 122 B | CRC OK | B=0 | SYM=0 | K=16 | D=1`

---

## 8. Explicit Non-Goals & Deferrals to Phase 5C.2+

The following components were intentionally **not** implemented in Phase 5C.1:

- ChaCha20-Poly1305 AEAD decryption on Android
- X25519 ECDH key agreement on Android
- HKDF-SHA256 key derivation on Android
- Key envelopes and key bootstrap protocols
- Replay protection database integration
- LT fountain peeling decoder on Android
- Multi-packet file reassembly
- SHA-256 file integrity verification
- MANIFEST / SYNC / CONTROL packet deserialization schemas
- Reverse optical channel signaling
- JavaScript / WebAssembly runtime on Android (QuickJS, WebView, React Native)
- Native C++/Rust/JNI integrations

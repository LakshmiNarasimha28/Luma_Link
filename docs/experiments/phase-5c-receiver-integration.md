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

## 8. Phase 5C.1 Verification Summary

- **Android Unit Tests**: `./gradlew testDebugUnitTest` $\to$ **35 passed, 0 failed**.
- **Android Assembly**: `./gradlew assembleDebug` $\to$ **BUILD SUCCESSFUL**.
- **Android Lint**: `./gradlew lintDebug` $\to$ **0 errors**.

---

## 9. Phase 5C.2 — Native Android AEAD Decryption & Security Context

### 9.1 Objective & Architectural Scope

Phase 5C.2 extends the Android optical receiver pipeline from raw framing and CRC-32 validation directly into authenticated ChaCha20-Poly1305 AEAD symbol decryption:

```
Physical Monitor Display (scripts/display-harness/index.html)
    │
    ▼ [Airgap Optical Channel]
Android CameraX (720p Y-Plane Luminance Capture, Center ROI)
    │
    ▼ [MultiFormatReader / Pure Java ZXing]
ResultMetadataType.BYTE_SEGMENTS (122-Byte Wire Stream)
    │
    ▼ [LumaPacketCodec]
42-Byte Big-Endian Header Parsing + IEEE 802.3 CRC-32 Validation
    │
    ▼ [Session Identification]
PreProvisionedSessionStore.get(packet.sessionId)
    │
    ▼ [LumaSecurityContext]
LumaReplayProtector ("${direction}:${packetTypeCode}:${blockIndex}:${symbolId}")
    │
    ▼ [Canonical Nonce & AAD Construction]
12-Byte Nonce + 26-Byte AAD
    │
    ▼ [Wire Tag/Ciphertext Adaptor]
[TAG (16B) || CIPHERTEXT (64B)] ──> [CIPHERTEXT (64B) || TAG (16B)]
    │
    ▼ [AndroidOpenSSL / JCA]
ChaCha20-Poly1305 Decryption & Poly1305 MAC Verification
    │
    ▼ [Authenticated Plaintext]
Exact 64-Byte Recovered Fountain Plaintext Symbol
    │
    ▼ [Diagnostic HUD Overlay]
"LUMA | DATA | 122 B | CRC OK | DECRYPT OK (64 B) | B=0 | SYM=0 | K=16 | D=1"
```

---

### 9.2 Cryptographic Invariants & Platform Primitives

The implementation exclusively uses native Android platform cryptography (`AndroidOpenSSL` via standard JCA APIs), adding zero external dependencies (no Bouncy Castle, Conscrypt, Tink, or libsodium):

1. **X25519 Key Agreement**:
   - Platform service: `KeyAgreement.getInstance("X25519")` (with fallback to `"XDH"`).
   - Raw 32-byte key import via standard ASN.1 DER wrapping (`X509EncodedKeySpec` with SPKI header for public keys, `PKCS8EncodedKeySpec` with PKCS#8 header for private keys).
   - Validated against canonical shared-secret golden vector (`c639664aff13ee...`).

2. **RFC 5869 HKDF-SHA256**:
   - HKDF-Extract: `PRK = HMAC-SHA256(salt, IKM)`.
   - HKDF-Expand: `OKM = HMAC-SHA256(PRK, T(i-1) || info || i)`.
   - Derives 32-byte ChaCha20-Poly1305 encryption key and 3-byte structured nonce salt prefix.

3. **ChaCha20-Poly1305 AEAD**:
   - Platform service: `Cipher.getInstance("ChaCha20-Poly1305")`.
   - `SecretKeySpec(key, "ChaCha20")` and `IvParameterSpec(nonce)`.
   - `updateAAD(aad)`.

---

### 9.3 Wire Tag/Ciphertext Ordering Adaptation (`testWireTagCiphertextOrdering`)

A fundamental convention difference exists between LumaLink's canonical wire specification and Java Cryptography Architecture (JCA):

- **LumaLink Wire Format**:
  $$\text{Payload} = [\text{Poly1305 Tag } (16\text{ B})] \parallel [\text{Ciphertext } (N\text{ B})]$$
- **JCA Convention**:
  $$\text{Buffer} = [\text{Ciphertext } (N\text{ B})] \parallel [\text{Poly1305 Tag } (16\text{ B})]$$

`AndroidCryptoProvider` and `LumaSecurityContext` perform byte-exact reordering:

- **Decryption**:
  ```kotlin
  val jcaBuffer = ByteArray(ciphertext.size + tag.size)
  System.arraycopy(ciphertext, 0, jcaBuffer, 0, ciphertext.size)
  System.arraycopy(tag, 0, jcaBuffer, ciphertext.size, tag.size)
  cipher.doFinal(jcaBuffer)
  ```
- **Encryption**:
  ```kotlin
  val jcaEncrypted = cipher.doFinal(plaintext)
  val ciphertextLen = jcaEncrypted.size - 16
  val wirePayload = ByteArray(jcaEncrypted.size)
  System.arraycopy(jcaEncrypted, ciphertextLen, wirePayload, 0, 16)
  System.arraycopy(jcaEncrypted, 0, wirePayload, 16, ciphertextLen)
  ```

This exact conversion is verified by the mandatory unit test `testWireTagCiphertextOrdering`.

---

### 9.4 Nonce & AAD Formats

#### 12-Byte Structured Nonce (`LumaNonce`)

- `[0]`: Domain Tag (`0x02` for sender DATA; Bit 7 = direction [0=sender, 1=receiver], Bits 3..0 = packetTypeCode [2=DATA])
- `[1..3]`: Salt Prefix (3 bytes from session keys)
- `[4..7]`: Block Index (uint32 big-endian)
- `[8..11]`: Symbol ID (uint32 big-endian)

#### 26-Byte Associated Authenticated Data (`LumaAad`)

- `[0..15]`: Session ID (16 raw UUID bytes)
- `[16..19]`: Block Index (uint32 big-endian)
- `[20..23]`: Symbol ID (uint32 big-endian)
- `[24]`: Packet Type Code (uint8, `2` for DATA)
- `[25]`: Flags (uint8, `0x02` for `FLAG_ENCRYPTED`)

---

### 9.5 Replay Protection Semantics (`LumaReplayProtector`)

`LumaReplayProtector` strictly mirrors canonical TypeScript `ReplayProtector`:

- Tracking key: `"${direction}:${packetTypeCode}:${blockIndex}:${symbolId}"`.
- Supports out-of-order fountain symbol reception.
- Provides strict domain separation (DATA does not block CONTROL) and direction separation (sender messages do not block receiver messages).
- Contains NO Android-specific LRU eviction, maxTracked bounding, or time-based expiry.

---

### 9.6 Session Keys & Test-Only Fixture Isolation

To prevent cryptographic secrets from being hardcoded in production receiver code:

1. `SessionKeys` is a pure data holder with redacted `toString()` (`[32 bytes REDACTED]`).
2. `PreProvisionedSessionStore` is a dynamic, thread-safe registry containing zero hardcoded secrets.
3. `TestFixtureSessions` contains all fixed golden vectors, keys, and session material in a dedicated test fixture module.

---

### 9.7 Diagnostic Receiver HUD States

`OpticalMeasurementReceiverActivity` updates the HUD to distinguish all 4 protocol states:

1. **Successful Decryption**:
   `LUMA | DATA | 122 B | CRC OK | DECRYPT OK (64 B) | B=0 | SYM=0 | K=16 | D=1`
2. **Replay Detected**:
   `LUMA | DATA | 122 B | CRC OK | DECRYPT FAIL (REPLAY) | B=0 | SYM=0`
3. **Authentication Failure (Tampered or Wrong Key)**:
   `LUMA | DATA | 122 B | CRC OK | DECRYPT FAIL (AUTH) | B=0 | SYM=0`
4. **Unrecognized Session**:
   `LUMA | DATA | 122 B | CRC OK | SESSION UNKNOWN | B=0 | SYM=0`

---

### 9.8 Verification Results

#### Android Unit Tests (`LumaSecurityContextTest` & Suites)

- `LumaSecurityContextTest`: **23/23 tests passed**
  - `testWireTagCiphertextOrdering`: **PASSED**
  - `testSuccessfulDecryption`: **PASSED**
  - `testRoundTripEncryptDecrypt`: **PASSED**
  - `testWrongKey`: **PASSED**
  - `testWrongNonceBlockIndex`: **PASSED**
  - `testWrongNonceSymbolId`: **PASSED**
  - `testWrongAadPacketType`: **PASSED**
  - `testWrongAadFlags`: **PASSED**
  - `testModifiedCiphertext`: **PASSED**
  - `testModifiedTag`: **PASSED**
  - `testTruncatedPayload`: **PASSED**
  - `testReplayDetection`: **PASSED**
  - `testReplayDisabled`: **PASSED**
  - `testDomainSeparation`: **PASSED**
  - `testDirectionSeparation`: **PASSED**
  - `testSessionIsolation`: **PASSED**
  - `testNonceGoldenVector`: **PASSED**
  - `testAadGoldenVector`: **PASSED**
  - `testX25519GoldenVector`: **PASSED**
  - `testHkdfGoldenVectors`: **PASSED**
  - `testChaCha20Poly1305GoldenVector`: **PASSED**
  - `testCompleteTransportPacketDecryption`: **PASSED**
  - `testPhase5bPacketWithEphemeralKeyFailsAuthControlled`: **PASSED**
- Total Android Unit Tests: **63 passed, 0 failed, 0 skipped**.
- Android Assembly: **BUILD SUCCESSFUL**.
- Android Lint: **0 errors**.

#### Repository Verification

- TypeScript Tests: `pnpm run test` $\to$ **22 test files, 153 tests passed**.
- Typecheck: `pnpm run typecheck` $\to$ **0 errors**.
- Lint: `pnpm run lint` $\to$ **0 warnings/errors**.
- Format: `pnpm run format:check` $\to$ **Clean**.
- Monorepo Build: `pnpm run build` $\to$ **Clean**.

---

### 9.9 Explicit Non-Goals & Deferrals to Phase 5D+

The following features remain explicitly outside Phase 5C.2:

- Dynamic key bootstrap (SessionAnnouncement, AuthRequest, AuthResponse, key envelope exchange)
- Reverse optical channel signaling
- Multi-packet file reassembly
- File-level SHA-256 validation
- MANIFEST / CONTROL / SYNC deserialization schemas

---

## 10. Phase 5C.3 — Android LT/Fountain Decoder Integration

### 10.1 Executive Summary & Architectural Pipeline

Phase 5C.3 integrates the canonical LumaLink TypeScript Luby Transform (LT) / Fountain decoder into the Android receiver harness. The conceptual decoding pipeline is:

```
Physical CameraX / ZXing
    │
    ▼
QrBytePayloadExtractor (BYTE_SEGMENTS)
    │
    ▼
LumaPacketCodec.decode() (Framing & CRC-32 Validation)
    │
    ▼
PreProvisionedSessionStore (Session Lookup)
    │
    ▼
LumaSecurityContext.decryptFromWirePayload() (ChaCha20-Poly1305 AEAD Decryption)
    │
    ▼ [Authenticated 64-byte Plaintext LT Symbol]
LumaLtDecoder.addSymbol()
    │
    ▼
BlockDecoder (Canonical Degree & Neighbor Derivation, XOR Reduction, LIFO Ripple Peeling)
    │
    ▼ [K=16 / 16 Source Symbols Recovered]
Reconstructed 1024-Byte Source Block (reconstructBlock())
    │
    ▼
STOP (File Reassembly & SHA-256 Intentionally Deferred to Phase 5C.4 / Phase 6)
```

---

### 10.2 Canonical TypeScript Parity Strategy

The Android LT implementation reproduces the exact mathematical, algorithmic, and stateful behavior of `@lumalink/core` (`packages/core/src/fec/`):

1. **Mulberry32 PRNG (`Prng.kt`)**:
   - 32-bit unsigned state initialized with `seed >>> 0` (if state is 0, falls back to `0x6d2b79f5`).
   - Bitwise arithmetic:
     - `state = (state + 0x6d2b79f5)`
     - `t = (state ^ (state >>> 15)) * (1 | state)`
     - `t = (t + ((t ^ (t >>> 7)) * (61 | t))) ^ t`
     - returns `(t ^ (t >>> 14)) >>> 0`
   - `nextFloat()`: converts unsigned 32-bit integer to `Double` divided by `4294967296.0`.
   - `nextInt(min, max)`: inclusive range `min + floor(nextFloat() * (max - min + 1))`.

2. **Robust Soliton Distribution (`RobustSolitonDistribution.kt`)**:
   - Parameters: $c = 0.1$, $\delta = 0.05$.
   - Robust spike calculation: $R = c \cdot \ln(K / \delta) \cdot \sqrt{K}$, $\text{pivot} = \max(1, \min(K, \lfloor K / R \rfloor))$.
   - Ideal soliton $\rho(d)$ and robust spike $\tau(d)$ normalized to cumulative distribution function (CDF) in double precision.
   - `sampleDegree()`: deterministic binary search over CDF using PRNG float.
   - `sampleNeighbors()`: partial Fisher-Yates shuffle selecting random indices within shuffle window $[i, K - 1]$, returning sorted ascending indices.

3. **Symbol Seed Derivation (`LtFountainMath.kt`)**:
   - `deriveSymbolSeed(blockIndex, symbolId)`:
     - Multiplies blockIndex and symbolId by prime constants `0x9e3779b9` and `0x85ebca6b`.
     - Preserves exact 32-bit integer truncation at each stage.
   - Packet Degree Validation (Section 6):
     - The LT graph is canonically derived from `(k, blockIndex, symbolId)`.
     - Packet `degree` field is used strictly as a consistency check.
     - Disagreement between `packet.degree` and canonically derived degree results in controlled rejection of the malformed symbol without inserting into the graph or crashing the decoder worker.

4. **Single-Block Peeling Decoder (`BlockDecoder.kt`)**:
   - State: `sourceSymbols: Array<ByteArray?>(K)`, `recoveredSymbolCount`, `equations: MutableSet<Equation>`, `sourceToEquations: MutableMap<Int, MutableSet<Equation>>`, `rippleQueue: ArrayDeque<Equation>`, `receivedSymbolIds: MutableSet<Long>`.
   - Peeling order: TypeScript uses `rippleQueue.pop()!` (LIFO). Kotlin strictly uses `ArrayDeque.removeLast()` to preserve identical equation reduction traversal order.
   - XOR cancellation: `(a[i].toInt() xor b[i].toInt()).toByte()` ensuring signed Kotlin bytes do not alter raw binary symbol data.
   - Reconstruct: returns concatenated $K \times \text{symbolSize}$ bytes once `recoveredSymbolCount == K`.

5. **Multi-Block Manager (`LumaLtDecoder.kt`)**:
   - Manages independent `BlockDecoder` instances keyed by `blockIndex`.
   - Supports out-of-order blocks, out-of-order symbols, duplicate arrivals, and parallel blocks.

---

### 10.3 Kotlin Semantic Traps Identified and Mitigated

1. **Unsigned Integer Division in `nextFloat()`**:
   - _Trap_: Casting signed Kotlin `Int` directly to `Double` produces negative values when bit 31 is set.
   - _Mitigation_: Masked with `0xFFFFFFFFL` before conversion: `(u32.toLong() and 0xFFFFFFFFL).toDouble() / 4294967296.0`.
2. **Double-to-Int Truncation in Seed Multiplication**:
   - _Trap_: In JavaScript, `x * 0x9e3779b9` uses 64-bit IEEE 754 floats before bitwise operators truncate to 32 bits.
   - _Mitigation_: 32-bit signed Kotlin `Int` multiplication truncates identically modulo $2^{32}$, matching `Math.imul(x, C)`.
3. **Ripple Queue Traversal Order**:
   - _Trap_: Using `removeFirst()` (FIFO) alters the peeling graph reduction order when multiple equations have degree 1 simultaneously.
   - _Mitigation_: `ArrayDeque.removeLast()` strictly matches JavaScript `Array.pop()` (LIFO).
4. **Equation Set Identity**:
   - _Trap_: Using a Kotlin `data class` for `Equation` hashes mutable byte arrays and unresolved neighbor sets, corrupting hash tables when mutated during peeling.
   - _Mitigation_: Regular `class Equation` with reference identity `equals`/`hashCode`, exactly matching JavaScript object references in `Set<Equation>`.

---

### 10.4 Deterministic Golden Parity Vectors

Verified across TypeScript and Kotlin unit tests:

#### Mulberry32 (Seed = 42)

- `nextUint32()` #1: `0x99e1ef7c`
- `nextUint32()` #2: `0x72c32b8a`
- `nextUint32()` #3: `0xda3b32c0`
- `nextFloat()` (subsequent call #4): `0.6697340414393693`
- `nextFloat()` (subsequent call #5): `0.17481389874592423`
- Fresh generator call #1: `0x99e1ef7c / 4294967296.0 = 0.6011037519201636`

#### Symbol Seeds (`blockIndex = 0`)

- `sym 0`: `0x00000000` (`0L`)
- `sym 1`: `0xcb72770f` (`3413276431L`)
- `sym 2`: `0xfebe41f4` (`4273881588L`)
- `sym 3`: `0x5197cd6a` (`1368903018L`)
- `sym 4`: `0x41c6db49` (`1103551305L`)

#### Symbol Neighbors ($K = 16, \text{blockIndex} = 0$)

- `sym 0`: degree `1`, neighbors: `[3]`
- `sym 1`: degree `13`, neighbors: `[0, 1, 3, 4, 5, 6, 8, 9, 10, 12, 13, 14, 15]`
- `sym 2`: degree `1`, neighbors: `[3]`
- `sym 3`: degree `6`, neighbors: `[0, 2, 7, 8, 13, 14]`
- `sym 4`: degree `2`, neighbors: `[10, 14]`

---

### 10.5 Authenticated Receiver Integration & Security Boundary

In `OpticalMeasurementReceiverActivity.kt`, the LT decoder is connected strictly downstream of successful AEAD authentication:

```kotlin
val plaintext = securityContext.decryptFromWirePayload(...)

// Phase 5C.3: Ingest authenticated symbol into canonical LT/Fountain decoder
lumaLtDecoder.addSymbol(
    blockIndex = packet.blockIndex,
    symbolId = packet.symbolId,
    k = packet.k,
    data = plaintext,
    degree = packet.degree
)
```

The HUD reflects real-time peeling progress:

- During decoding: `LUMA | DATA | 122 B | CRC OK | DECRYPT OK (64 B) | B=0 | SYM=X | FEC: Y/16`
- On completion: `LUMA | DATA | 122 B | CRC OK | DECRYPT OK (64 B) | B=0 | SYM=X | FEC: 16/16 (100% COMPLETE)`

Security Boundary Invariants:

1. **Unauthenticated Packets**: Unknown session ID rejects packet before decryption; zero symbols reach the LT decoder.
2. **Tampered Ciphertext**: ChaCha20-Poly1305 tag verification fails (`DecryptionException`); zero symbols reach the LT decoder.
3. **Tampered AAD**: Packet framing/flags altered fails AEAD verification (`DecryptionException`); zero symbols reach the LT decoder.
4. **Replay Protection**: Replayed packet rejected by `LumaReplayProtector` (`ReplayException`); zero duplicates reach the LT decoder.
5. **Inconsistent Degree**: Packets claiming a degree differing from canonical derivation are rejected without insertion.

---

### 10.6 Test Fixture & Parity Test Suite

#### Test-Only Integration Fixture (`LtPacketIntegrationFixture.kt`)

- Located strictly in `app/src/test/java/com/lumalink/harness/fec/`.
- Zero secrets in production source code.
- Generates a deterministic 1024-byte source block ($K=16$, $\text{symbolSize}=64$).
- Canonical LT encoding produces 20 valid 122-byte wire packets authenticated with the Phase 5C.2 golden session keys.
- Also added as sequence `GOLDEN_FEC_BLOCK_16` to `scripts/display-harness/index.html` for physical camera validation on the Samsung Galaxy M04.

#### Automated Test Verification Results

- **Android Unit & Integration Tests**: `./gradlew testDebugUnitTest` $\to$ **98/98 tests passed** (0 failures, 0 skipped).
  - `PrngTest`: 7 tests passed (Mulberry32 golden vectors).
  - `RobustSolitonDistributionTest`: 7 tests passed (CDF, degree & neighbor bounds).
  - `LtFountainMathTest`: 3 tests passed (seed & neighbor golden parity).
  - `BlockDecoderTest`: 8 tests passed (peeling, ripple, duplicate rejection, stalled, K=16 decode).
  - `LumaLtDecoderTest`: 3 tests passed (multi-block isolation, auto-registration, reset).
  - `LtPacketIntegrationTest`: 6 tests passed (full wire $\to$ CRC $\to$ AEAD $\to$ LT $\to$ source block, out-of-order, and 4 security boundaries).
  - Existing security & packet suites (`LumaSecurityContextTest`, `LumaPacketCodecTest`, etc.): 64 tests passed.
- **Android Assembly**: `./gradlew assembleDebug` $\to$ **BUILD SUCCESSFUL**.
- **Android Lint**: `./gradlew lintDebug` $\to$ **0 errors**.
- **Monorepo TypeScript Verification**:
  - `pnpm run test` $\to$ **22 files, 153 tests passed**.
  - `pnpm run typecheck` $\to$ **0 errors**.
  - `pnpm run lint` $\to$ **0 warnings/errors**.
  - `pnpm run format:check` $\to$ **Clean**.
  - `pnpm run build` $\to$ **Clean**.

---

### 10.7 Phase 5C.3 Limitations & Non-Goals

Phase 5C.3 intentionally stops after source block reconstruction:

- File reassembly (stripping padding from source block, concatenating multiple blocks) is deferred.
- File-level SHA-256 verification is deferred.
- Dynamic key bootstrap (SessionAnnouncement, AuthRequest/AuthResponse) is deferred.
- Reverse optical channel signaling is deferred.
- RaptorQ or systematic LT redesigns are excluded.

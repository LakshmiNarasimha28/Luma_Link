# LumaLink Phase 6.3 — Key Envelope Binary Wire Format & Session-Key Control Protocol

## 1. Executive Summary

Phase 6.3 establishes the canonical binary wire representation for the LumaLink CONTROL plane (`TYPE_CONTROL = 4`) and implements Android receiver-side KeyEnvelope unwrapping and dynamic session-key establishment.

The receiver architecture implements the canonical pipeline:

```
MANIFEST (TYPE_MANIFEST = 1)
   ↓
receiver obtains activeManifest.senderPublicKey
   ↓
[CONTROL / AUTH_REQUEST (0x01)]       ← software / JVM bidirectional bootstrap only
   ↓
sender authorization (Quick Send / Private Send)
   ↓
CONTROL / AUTH_RESPONSE (0x02) / KEY_ENVELOPE (TYPE_CONTROL = 4)
   ↓
[MANDATORY SECURITY INVARIANT]
verify: envelope.ephemeralPublicKey == activeManifest.senderPublicKey
   ↓ (fail-closed if mismatch: ManifestKeyMismatchException, zero crypto operations)
X25519 ECDH (receiverPrivateKey, envelope.ephemeralPublicKey) -> Z
   ↓
HKDF-SHA256 (IKM = Z, salt = sessionId, info = "LumaLink-KeyWrap-v1", length = 32) -> K_wrap
   ↓
ChaCha20-Poly1305 Decryption (key = K_wrap, nonce = wrapNonce, tag || ciphertext, AAD = "LumaLink-Envelope:sessionId:targetDeviceId")
   ↓
K_broadcast (32-byte masterSharedSecret)
   ↓
deriveSessionKeys(K_broadcast, sessionId, mode) -> SessionKeys (bulk encryptionKey, nonceSalt)
   ↓
LumaSecurityContext registered in active session security store
   ↓
DATA (TYPE_DATA = 2) packet decryption and LT / reassembly processing succeeds
```

---

## 2. Simplex Channel Limitation & Operational Boundaries

### 2.1 Physical Simplex Optical Channel: Pre-Arranged Key Envelope Delivery
On the physical simplex optical channel (Sender Display → Receiver Camera), the channel is strictly unidirectional. The receiver cannot transmit an optical `AUTH_REQUEST` back to the sender.
- **Physical Delivery Classification:** **PRE-ARRANGED KEY ENVELOPE DELIVERY** (test-fixture delivery sealed to receiver identity `device-bob` with public key `BOB_PUB`).
- **HUD Indicator:** The receiver HUD explicitly labels this state as:
  `KEY ENVELOPE — PRE-ARRANGED — ACQUIRED`
- **Distinction:** This is strictly distinguished from dynamic software bootstrap. Dynamic key bootstrap over the optical channel would require a bidirectional physical transport.

### 2.2 Software / JVM Bidirectional Control Plane: Dynamic Key Bootstrap
In bidirectional software environments (JVM / TypeScript unit and integration test harnesses):
- The receiver generates `AUTH_REQUEST` (0x01).
- The sender evaluates authorization (Quick Send auto-approves; Private Send transitions `pending` → `authorized` / `rejected`).
- The sender emits `AUTH_RESPONSE` (0x02) containing the sealed `KEY_ENVELOPE`.
- The receiver unwraps $K_{broadcast}$ dynamically without pre-provisioned keys.

### 2.3 Active MITM Limitation Notice
Phase 6.3 enforces pairwise ECDH key-wrapping ($K_{wrap}$) and cryptographic binding between the `activeManifest.senderPublicKey` and `envelope.ephemeralPublicKey`. However, in the absence of an authenticated out-of-band identity verification mechanism (such as Short Authentication String / SAS or pre-certified public keys), Phase 6.3 does **not** protect against an active optical Man-in-the-Middle who substitutes both the manifest and the key envelope simultaneously. It provides forward secrecy and pairwise channel confidentiality against passive observers.

---

## 3. CONTROL Transport Framing

CONTROL messages are encapsulated in standard 42-byte `TransportPacket` frames without modifications to the transport header:
- `protocolVersion` = 1
- `packetType` = 4 (`TYPE_CONTROL`)
- `flags` = 0
- `reserved` = 0
- `sessionId` = 16-byte UUID bytes
- `blockIndex` = 0
- `symbolId` = `messageId` (monotonically increasing sequence number per sender/direction)
- `k` = 0
- `degree` = 0
- `payloadLength` = byte length of binary CONTROL message
- `checksum` = CRC-32 (IEEE 802.3 over `header[0..37] || payload`)

---

## 4. Binary Wire Formats

All numeric fields are encoded in **Big-Endian**. Strings are encoded in **strict UTF-8** with 1-byte length prefixes. All decoders fail closed upon malformed bytes, invalid lengths, unknown versions, or trailing bytes.

### 4.1 AUTH_REQUEST Wire Layout (0x01)

| Offset | Width | Field | Description |
|---|---|---|---|
| 0 | 1 | `controlMessageType` | Constant `0x01` (`TYPE_AUTH_REQUEST`) |
| 1 | 1 | `controlVersion` | Constant `0x01` (`CURRENT_VERSION`) |
| 2..3 | 2 | `reserved` | Must be `0x0000` (non-zero rejected) |
| 4..19 | 16 | `sessionId` | 16-byte raw session UUID bytes |
| 20..27 | 8 | `timestamp` | uint64 Big-Endian Unix epoch ms |
| 28..59 | 32 | `receiverPublicKey` | 32-byte X25519 public key |
| 60 | 1 | `receiverDeviceIdLength` | Length $N$ ($1 \le N \le 64$) |
| 61.. | $N$ | `receiverDeviceId` | UTF-8 encoded receiver device ID |

**Total Size:** $61 + N$ bytes.

### 4.2 AUTH_RESPONSE / KEY_ENVELOPE Wire Layout (0x02)

| Offset | Width | Field | Description |
|---|---|---|---|
| 0 | 1 | `controlMessageType` | Constant `0x02` (`TYPE_AUTH_RESPONSE`) |
| 1 | 1 | `controlVersion` | Constant `0x01` (`CURRENT_VERSION`) |
| 2 | 1 | `authState` | `0x01` = AUTHORIZED, `0x02` = REJECTED, `0x03` = PENDING |
| 3 | 1 | `statusFlags` | Status flags / reason code (e.g. `0x00` OK, `0x05` rejected) |
| 4..19 | 16 | `sessionId` | 16-byte raw session UUID bytes |
| 20 | 1 | `targetDeviceIdLength`| Length $N$ ($1 \le N \le 64$) |
| 21.. | $N$ | `targetDeviceId` | UTF-8 encoded target receiver device ID |

#### Conditional AUTHORIZED Payload (appended only when `authState == 0x01`):
| Offset | Width | Field | Description |
|---|---|---|---|
| $21 + N$ | 32 | `ephemeralPublicKey` | Sender ephemeral X25519 public key |
| $53 + N$ | 12 | `wrapNonce` | 12-byte random AEAD nonce |
| $65 + N$ | 16 | `wrapTag` | 16-byte Poly1305 authentication tag |
| $81 + N$ | 32 | `wrappedCiphertext` | 32-byte ChaCha20 encrypted $K_{broadcast}$ |

**Wire Length Constraints:**
- `REJECTED` (`0x02`): Exactly $21 + N$ bytes.
- `PENDING` (`0x03`): Exactly $21 + N$ bytes.
- `AUTHORIZED` (`0x01`): Exactly $113 + N$ bytes ($21 + N + 92$ bytes envelope).

---

## 5. Security & State Invariants

### 5.1 Manifest-to-Envelope Ephemeral Key Binding (Mandatory)
Before executing any cryptographic operation (X25519 ECDH, HKDF-SHA256, or ChaCha20-Poly1305 decryption):
```kotlin
if (!envelope.ephemeralPublicKey.contentEquals(activeManifest.senderPublicKey)) {
    throw ManifestKeyMismatchException(...)
}
```
If the keys mismatch:
- Decryption is aborted immediately.
- Zero cryptographic primitives are executed.
- No security context is created or registered.
- Incoming DATA packets fail closed.

### 5.2 Complete Key Envelope Equality & Deduplication
Optical transmissions repeat packets across carousels. When an `AUTHORIZED` envelope arrives for an already-established session:
- The receiver compares the entire binary envelope payload (`rawBytes` or all fields: `authState`, `targetDeviceId`, `ephemeralPublicKey`, `wrapNonce`, `wrapTag`, `wrappedCiphertext`).
- **Byte-for-byte Identical:** Returns `DuplicateAccepted`. No cryptographic re-computation, no state reset, no FEC/reassembly reset.
- **Any Field / Byte Differs:** Throws `ConflictingKeyEnvelopeException`. Fails closed; never silently overwrites an active session key.

### 5.3 Authorization State Machine vs. Envelope Conflict
The authorization state transitions are distinct from envelope deduplication:
- `PENDING` → `AUTHORIZED` (permitted during interactive/dynamic handshake).
- `PENDING` → `REJECTED` (permitted).
- Once `AUTHORIZED` is established: identical repeats are accepted; conflicting envelopes are strictly rejected.

### 5.4 CONTROL Transport Replay vs. Carousel Repetition
Transport sequence tracking (`symbolId = messageId`) is used for transport-level sequence diagnostics. However, optical carousel repetition repeats valid control frames identically. Replay checks therefore do not reject identical repeated envelopes on the optical carousel.

---

## 6. Implementation Reference

- **TypeScript Codec:** [`packages/core/src/security/control-codec.ts`](file:///c:/Users/laksh/OneDrive/Desktop/Luma_Link/packages/core/src/security/control-codec.ts)
- **Kotlin Codec:** [`apps/android-harness/app/src/main/java/com/lumalink/harness/crypto/LumaControlCodec.kt`](file:///c:/Users/laksh/OneDrive/Desktop/Luma_Link/apps/android-harness/app/src/main/java/com/lumalink/harness/crypto/LumaControlCodec.kt)
- **Kotlin Unwrapper:** [`apps/android-harness/app/src/main/java/com/lumalink/harness/crypto/LumaKeyEnvelopeUnwrapper.kt`](file:///c:/Users/laksh/OneDrive/Desktop/Luma_Link/apps/android-harness/app/src/main/java/com/lumalink/harness/crypto/LumaKeyEnvelopeUnwrapper.kt)
- **Receiver Activity:** [`apps/android-harness/app/src/main/java/com/lumalink/harness/OpticalMeasurementReceiverActivity.kt`](file:///c:/Users/laksh/OneDrive/Desktop/Luma_Link/apps/android-harness/app/src/main/java/com/lumalink/harness/OpticalMeasurementReceiverActivity.kt)
- **Phase 6.4 Physical Validation Report:** [`docs/experiments/phase-6-physical-validation.md`](file:///c:/Users/laksh/OneDrive/Desktop/Luma_Link/docs/experiments/phase-6-physical-validation.md)


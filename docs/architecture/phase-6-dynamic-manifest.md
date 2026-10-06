# Phase 6.2 — Dynamic Manifest Acquisition Pipeline

## 1. Architectural Overview & Objective

Phase 6 replaces the static, pre-provisioned manifest dependency in the LumaLink Android receiver with a dynamic, session-bound control-plane pipeline acquired directly over the visual optical channel.

### Previous Flow (Phase 5):
```
PreProvisionedManifestStore
        ↓ (hardcoded / pre-seeded manifest)
known manifest
        ↓
DATA processing
```

### Dynamic Pipeline (Phase 6.2):
```
MANIFEST Optical Frame (QR)
      ↓
CameraX (Luminance Source / Center ROI)
      ↓
ZXing BYTE_SEGMENTS Extraction
      ↓
LumaPacketCodec.decode()
      ↓
Packet Demultiplexing (packetType == 1 [TYPE_MANIFEST])
      ↓
LumaManifestCodec.decode()
      ↓
SessionManifestStore.register(announcement)
      ↓
Session Context Established (Session-Bound by sessionId)
      ↓
DATA Packet Arrival (packetType == 2 [TYPE_DATA])
      ↓
SessionManifestStore.getManifest(packet.sessionId) [FAIL-CLOSED]
      ↓
AEAD Decryption (ChaCha20-Poly1305)
      ↓
LumaLtDecoder (Peeling Decoder / Fountain Peeling)
      ↓
LumaFileReassembler (Multi-block file reassembly)
      ↓
SHA-256 Digest Verification
      ↓
FILE OK / FILE CORRUPT
```

---

## 2. Dynamic Manifest Store (`SessionManifestStore`)

`SessionManifestStore` is a thread-safe, concurrent registry keyed strictly by the 16-byte `sessionId`:

1. **Session-Bound Identity**:
   - The primary key is exclusively the canonical 16-byte `sessionId`.
   - Never keyed by `fileName`, `senderDeviceId`, `timestamp`, or any arbitrary metadata.
   - Session A manifest can never become metadata for Session B.

2. **Interface**:
   - `register(announcement: LumaSessionAnnouncement): ManifestRegistrationResult`
   - `get(sessionId: ByteArray): LumaSessionAnnouncement?`
   - `getManifest(sessionId: ByteArray): LumaFileManifest?`
   - `contains(sessionId: ByteArray): Boolean`
   - `remove(sessionId: ByteArray): Boolean`
   - `clear(): Unit`
   - `count(): Int`

---

## 3. Manifest Conflict Semantics & Idempotence

When a `MANIFEST` packet arrives over the air:

### Case A — New Session (First Arrival)
- `sessionId` not present in store.
- Validate manifest structure and parameter bounds.
- Atomically register in `ConcurrentHashMap`.
- Returns `ManifestRegistrationResult.Accepted`.
- Receiver establishes session context and prepares HUD display.

### Case B — Existing Session + Identical Manifest (Idempotent Arrival)
- `sessionId` already present in store.
- Compares all canonical manifest fields for exact equality:
  - Protocol version (`1`)
  - Security mode (`quick` / `private`)
  - Session ID (16 bytes)
  - Timestamp (int64)
  - File size (int64)
  - Total blocks (int32)
  - Symbol size (int16)
  - Symbols per block / $K$ (int16)
  - Sender public key (32 bytes)
  - Expected SHA-256 digest (32 bytes / 64 hex chars)
  - Sender device ID (UTF-8 string)
  - File name (UTF-8 string)
- If identical: returns `ManifestRegistrationResult.DuplicateAccepted`.
- Idempotent: does not reset active reassemblers, does not duplicate sessions, does not corrupt state.
- Supports continuous repeated transmission from sender and late-joining receivers.

### Case C — Existing Session + Conflicting Manifest (Tampering / Conflict)
- `sessionId` already present in store.
- Any single field differs from the registered manifest.
- Rejection: throws `ConflictingManifestException` (`SESSION_CONFLICT`).
- **Original manifest is strictly preserved**.
- Conflicting manifest is rejected and never overwrites existing state.

---

## 4. DATA-Before-MANIFEST Fail-Closed Invariant

To prevent unauthorized or undefined state transitions:

1. When a `DATA` packet (`packetType == 2`) arrives:
   ```kotlin
   val manifest = SessionManifestStore.getManifest(packet.sessionId)
   if (manifest == null) {
       // FAIL CLOSED: Drop immediately without decryption or FEC ingestion
       protocolStatus = "LUMA | DATA | ... | REJECTED (NO MANIFEST)"
       return
   }
   ```
2. The receiver:
   - Does **not** guess file size, filename, SHA-256, $K$, or total blocks from DATA packets.
   - Does **not** create implicit or speculative manifests.
   - Drops DATA packets until a valid, authenticated `MANIFEST` packet has been received and registered.

---

## 5. Simplex Boundary & Dynamic Key Bootstrap Distinction

### Simplex Limitation:
The physical channel in Phase 6 is strictly **simplex** (unidirectional: Sender Display $\to$ Airgap $\to$ Receiver Camera).
- The optical channel has no reverse path (Receiver $\to$ Sender).
- The receiver cannot transmit an `AuthRequest` back to the sender optically without a secondary screen or bidirectional transceiver.

### Distinction: Dynamic Manifest Acquisition vs. Dynamic Key Bootstrap:
- **Phase 6.2 (Current Milestone)** implements **dynamic manifest acquisition**:
  - The file manifest metadata is dynamically transmitted via `MANIFEST` visual frames, decoded by `LumaManifestCodec`, and registered in `SessionManifestStore`.
  - The receiver starts with **zero pre-provisioned manifest**.
- **Phase 6.3 (Next Milestone)** will implement **dynamic key bootstrap**:
  - Exchange of ephemeral key envelopes / AuthRequest-AuthResponse structures.
  - In Phase 6.2, cryptographic session keys continue to use the established test/golden session context (`PreProvisionedSessionStore`) while the manifest acquisition pipeline is completely dynamic.
- **Phase 6 is NOT fully dynamically bootstrapped yet.** It achieves dynamic manifest/control-plane transmission.

---

## 6. Physical Harness Preparation

The PC sender display harness (`scripts/display-harness/index.html` and `scripts/generate-phase5b-packets.ts`) has been prepared with interleaved sequence scheduling:
```
MANIFEST
DATA
DATA
DATA
MANIFEST
DATA
...
```
- Receivers starting before transmission acquire the session immediately on frame 1.
- Late-joining receivers that boot up during mid-transmission acquire the session on the next repeated MANIFEST frame and seamlessly ingest subsequent fountain DATA frames.
- Repetition of MANIFEST frames is completely idempotent and harmless.

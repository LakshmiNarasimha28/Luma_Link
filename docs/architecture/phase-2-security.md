# Phase 2: Security & Session Architecture

## 1. Executive Summary

Phase 2 establishes the cryptographic security and session management layer for LumaLink. It provides end-to-end authenticated encryption, replay protection, domain-isolated nonces, and access control across airgapped visual channels without introducing dependencies on camera hardware or mobile UI frameworks.

---

## 2. End-to-End Cryptographic Flow

```text
SENDER SESSION INITIALIZATION
    ├── Generates fresh random 256-bit Broadcast Master Key (K_broadcast)
    └── Generates ephemeral Curve25519 keypair (sk_eph, pk_eph)
         ↓
BULK DATA ENCRYPTION (Performed ONCE for broadcast)
    ├── Derives AEAD Key (32B) & Nonce Salt Prefix (3B) via HKDF-SHA256
    └── Encrypts Luby Transform fountain symbols via ChaCha20-Poly1305 with AAD binding
         ↓
SESSION ANNOUNCEMENT (Broadcast over visual / transport channel)
    └── Contains: SessionId, Mode, SenderDeviceId, Ephemeral PublicKey, Manifest
         ↓
KEY DISTRIBUTION & ENCAPSULATION
    ├── QUICK SEND: Open-access automatic approval
    │     Receiver sends AuthRequest(pk_R) → Sender automatically returns EncryptedKeyEnvelope
    └── PRIVATE SEND: Explicit whitelist approval
          Receiver sends AuthRequest(pk_R) → Sender UI prompts → approveReceiver() returns EncryptedKeyEnvelope
         ↓
PAIRWISE KEY UNWRAPPING (At Receiver)
    ├── Z = X25519(sk_R, pk_eph)
    ├── K_wrap = HKDF(Z, SessionId, "LumaLink-KeyWrap-v1", 32)
    └── K_broadcast = decryptAead(K_wrap, wrapNonce, wrappedKey, AAD)
         ↓
AEAD REPLAY & DECRYPTION FILTER
    ├── Domain & Direction isolated ReplayProtector filter
    └── ChaCha20-Poly1305 AEAD decryption with 26-byte AAD verification
         ↓
DECRYPTED SOURCE SYMBOLS → LT PEELING DECODER → REASSEMBLER → SHA-256 VERIFIED
```

---

## 3. Core Cryptographic Components

### 3.1 `CryptoProvider` & `NodeCryptoProvider`

- Abstract provider in `packages/core/src/security/crypto-provider.ts` backed by native Node `node:crypto`. Zero external npm dependencies.
- Features:
  - `generateKeyPair()`: Fresh 32-byte Curve25519 keypairs.
  - `computeSharedSecret(privateKey, publicKey)`: X25519 ECDH scalar multiplication.
  - `hkdf(ikm, salt, info, length)`: RFC 5869 key derivation with SHA-256.
  - `encryptAead(key, nonce, plaintext, associatedData)`: ChaCha20-Poly1305 (RFC 8439) with 128-bit authentication tag.
  - `decryptAead(key, nonce, payload, associatedData)`: ChaCha20-Poly1305 authenticated decryption with constant-time tag verification.

### 3.2 Key Derivation & Removal of Unused Keys

- **Derived Session Keys**:
  1. `encryptionKey` (32 bytes): ChaCha20-Poly1305 bulk encryption key.
  2. `nonceSalt` (3 bytes): Session salt prefix embedded into structured nonces.
- **Decision on `authKey`**:
  - The redundant `authKey` has been removed from `SessionKeys` and `deriveSessionKeys`. ChaCha20-Poly1305 is an AEAD construction that natively generates a one-time Poly1305 authenticator key per packet from the cipher state, rendering an independent MAC key superfluous.

### 3.3 Structured Nonce Manager (`NonceManager`)

- Constructs deterministic 96-bit (12-byte) nonces with explicit domain and direction separation:
  ```text
  [0]     Domain Tag (1 byte: Bit 7 = Direction, Bits 3..0 = PacketTypeCode)
  [1..3]  Salt Prefix (3 bytes, derived from master secret)
  [4..7]  Block Index (uint32 BE)
  [8..11] Symbol ID / Sequence Number (uint32 BE)
  ```
- **Mathematical Invariant**:
  - Direction bit separates outbound sender packets (`0x00`) from inbound receiver control messages (`0x80`).
  - Packet type code separates DATA packets (`0x02`) from CONTROL messages (`0x04`).
  - Nonce spaces are mathematically disjoint: nonces across domains and directions can never collide.

### 3.4 Replay Protector (`ReplayProtector`)

- Sequences are tracked with composite keys:
  $$\text{Key} = \text{direction} \parallel \text{packetTypeCode} \parallel \text{blockIndex} \parallel \text{symbolId}$$
- Guarantees that DATA packets do not block CONTROL packets, sender packets do not collide with receiver packets, and legitimate out-of-order fountain symbols are accepted.

### 3.5 Authorization Manager (`AuthorizationManager`)

- Centralizes key encapsulation logic for both Quick Send and Private Send.
- Uses pairwise X25519 ECDH + HKDF (`"LumaLink-KeyWrap-v1"`) + ChaCha20-Poly1305 AEAD bound to `sessionId` and `receiverDeviceId`.
- **Quick Send**: Open policy; automatically encapsulates and returns `EncryptedKeyEnvelope` in `handleAuthRequest`.
- **Private Send**: Closed policy; records requests as `pending` until explicit `approveReceiver` or `rejectReceiver`.

---

## 4. Security Properties & Threat Model

### What Quick Send Protects Against:

1. **Passive Observers / Eavesdropping**: Broadcast streams cannot be decrypted by passive listeners who only capture visual frames or network announcements. The broadcast master secret is randomly generated and only distributed inside pairwise-encrypted envelopes.
2. **Ciphertext Tampering**: Any altered bits in transit trigger an immediate `DecryptionError`.
3. **Replay Attacks**: Duplicate packets or packets injected from previous sessions are rejected by AAD binding and `ReplayProtector`.
4. **Session Confusion**: AAD binds every packet to the 16-byte `sessionId`, preventing inter-session packet injection.

### What Quick Send Does Not Protect Against:

1. **Active MITM**: Because raw Curve25519 public keys in the announcement are unauthenticated, an active attacker modifying packets on the channel could substitute ephemeral keys.
2. **Unauthorized Handshakes**: Quick Send does not require sender user approval; any receiver actively requesting access will receive a valid key envelope.

### Deferred Capabilities (Phase 4 / 5):

- Long-term device identity authentication and signature verification (Ed25519).
- Out-of-band Short Authentication String (SAS) / numeric confirmation codes displayed on device screens for active MITM resistance.

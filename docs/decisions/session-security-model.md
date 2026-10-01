# ADR-004: Session Security & Authorization Model (Quick Send vs. Private Send)

## Status

Accepted (Amended in Phase 2 Cryptographic Review)

## Date

2026-10-01

## Context

LumaLink must accommodate two distinct operational security scenarios over the transport layer:

1. **Quick Send**: Rapid, low-friction broadcast to one or more nearby receivers without interactive sender approval (e.g. sharing a presentation, document, or dataset to an audience).
2. **Private Send**: High-assurance transfer of sensitive or confidential files where the sender explicitly authenticates and authorizes each receiving device before granting decryption capability.

Both modes must defend against passive eavesdropping, message forgery, and transmission tampering.

---

## 1. Quick Send Authorization Model

- **Policy**: Open Authorization / Automatic Key Encapsulation.
- **Key Lifecycle & Distribution Flow**:
  1. **Broadcast Session Key Generation**: The sender generates a fresh, cryptographically random 256-bit master broadcast session key $K_{broadcast} \xleftarrow{\$} \{0,1\}^{256}$ and an ephemeral Curve25519 keypair $(sk_{eph, S}, pk_{eph, S})$.
  2. **Single Stream Bulk Encryption**: The file data is fountain-encoded and encrypted **once** under keys derived from $K_{broadcast}$ via ChaCha20-Poly1305.
  3. **Session Announcement**: The sender broadcasts `SessionAnnouncement` containing `sessionId`, $pk_{eph, S}$, and file metadata. $K_{broadcast}$ is **never** broadcast in plaintext.
  4. **Receiver Key Acquisition**:
     - A prospective receiver generates a keypair $(sk_R, pk_R)$ and presents an `AuthRequest(sessionId, receiverDeviceId, pk_R)`.
     - Because Quick Send enforces an open policy, the sender **automatically** approves the request and performs pairwise key encapsulation:
       $$Z = \text{X25519}(sk_{eph, S}, pk_R)$$
       $$K_{wrap} = \text{HKDF}(Z, \text{sessionId}, \text{"LumaLink-KeyWrap-v1"}, 32)$$
       $$\text{wrappedSessionKey} = \text{encryptAead}(K_{wrap}, \text{wrapNonce}, K_{broadcast}, \text{AAD})$$
     - The sender returns an `AuthResponse` with `state: 'authorized'` containing `EncryptedKeyEnvelope`.
  5. **Receiver Decryption**:
     - The receiver unwraps $K_{broadcast}$ using $sk_R$.
     - Any number of receivers ($R_1, R_2, \dots$) can obtain the identical $K_{broadcast}$ wrapped under their respective public keys.
     - Receivers decrypt the shared bulk data stream without re-encrypting the payload.
- **Security Properties**:
  - **Confidentiality against Passive Observers**: A passive eavesdropper who only captures the broadcast announcement and data stream cannot decrypt the transmission because $K_{broadcast}$ is unrecoverable without completing key agreement. Even if the observer records the key envelope sent to Receiver A, computing $Z$ requires $sk_{eph, S}$ or $sk_A$ (CDH assumption on Curve25519).
  - **Single Transmission Overhead**: Bulk payload is encrypted once; key distribution requires only a 48-byte key envelope per receiver.
  - **Late Joining Support**: A receiver joining at packet $N$ requests an envelope, derives $K_{broadcast}$, and decodes the stream using fountain peeling decoding.

---

## 2. Private Send Authorization Model

- **Policy**: Explicit Closed Authorization / Whitelist.
- **Workflow**:
  1. **Device Identity**: Both sender and receiver possess distinct device identity keypairs $(sk_S, pk_S)$ and $(sk_R, pk_R)$.
  2. **Session Invitation / Announcement**: Sender broadcasts session metadata with an ephemeral session public key $pk_{eph, S}$ and random $K_{broadcast}$.
  3. **Authorization Request**: Receiver presents an `AuthRequest` with $pk_R$ and device identifier.
  4. **Sender Approval Lifecycle**:
     - Sender UI receives the request and marks it `pending`.
     - The sender user inspects the receiver's device fingerprint out-of-band and explicitly calls `approveReceiver` or `rejectReceiver`.
     - If approved, the sender encapsulates $K_{broadcast}$ into an `EncryptedKeyEnvelope` for that receiver.
     - If rejected, no key envelope is ever generated, and authorization is denied.
  5. **Decryption**:
     - Only the explicitly approved receiver holding $sk_R$ can unwrap $K_{broadcast}$ and decrypt the stream.

---

## 3. Threat Model & Mitigation Matrix

| Threat                                  | Scope                                          | Quick Send Mitigation                                                                        | Private Send Mitigation                                                                                       |
| :-------------------------------------- | :--------------------------------------------- | :------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------ |
| **Passive Observation (Eavesdropping)** | Sniffing broadcast stream / optical recording  | Protected: $K_{broadcast}$ is random and only delivered via ECDH-wrapped key envelopes.      | Protected: $K_{broadcast}$ is random and delivered only via ECDH-wrapped key envelopes to approved receivers. |
| **Ciphertext Modification**             | Optical link noise / bit flips                 | Protected: ChaCha20-Poly1305 128-bit authentication tag rejects corrupted packets.           | Protected: ChaCha20-Poly1305 128-bit authentication tag rejects corrupted packets.                            |
| **Forged / Injected Messages**          | Attacker injects fake fountain blocks          | Protected: Poly1305 verification fails without valid session key; packet dropped.            | Protected: Poly1305 verification fails without valid session key; packet dropped.                             |
| **Unauthorized Receivers**              | Rogue device attempts to join session          | Unprotected by design: Quick Send is open-access (anyone requesting can obtain envelope).    | Protected: Requires explicit sender approval; unapproved devices receive no envelope.                         |
| **Replay Attacks**                      | Attacker replays frames from past transfer     | Protected: `ReplayProtector` domain filter + session ID AAD binding.                         | Protected: `ReplayProtector` domain filter + session ID AAD binding.                                          |
| **Active Man-in-the-Middle (MITM)**     | Active attacker modifies ephemeral public keys | **Limitation**: Unauthenticated X25519 does not prevent active MITM without out-of-band SAS. | **Limitation**: Unauthenticated X25519 does not prevent active MITM without out-of-band SAS.                  |

---

## 4. Current Limitations & Deferred Capabilities

1. **Active MITM Defense**:
   - X25519 Diffie-Hellman guarantees confidentiality against passive observers and authenticates that a key envelope was sealed for a specific public key.
   - However, raw public keys in visual broadcasts are unauthenticated. An active attacker on the channel could substitute ephemeral keys.
   - **Deferred to Phase 4 / 5**: Long-term identity signing (Ed25519) and visual Short Authentication String (SAS) / numeric confirmation codes displayed on both screens for human verification.
2. **Reverse Optical Channel**:
   - In pure unidirectional optical transfer (screen $\to$ camera without reverse channel), `AuthRequest` requires either a dual-screen handshake or an out-of-band control channel. In Phase 2, this is modeled in a transport-independent manner.

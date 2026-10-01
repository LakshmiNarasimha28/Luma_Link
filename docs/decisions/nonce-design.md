# ADR-003: Nonce Construction, Domain Separation & Replay Invariant

## Status

Accepted (Amended in Phase 2 Review)

## Date

2026-10-01

## Context

ChaCha20-Poly1305 is an AEAD cipher requiring a 96-bit (12-byte) nonce.
A fundamental cryptographic invariant of ChaCha20-Poly1305 (and all Galois/counter mode AEAD ciphers) is:

$$\text{An AEAD key MUST NEVER be reused with the same nonce.}$$

Nonce reuse under the same key leads to catastrophic loss of confidentiality and authenticity (recovering the internal Poly1305 authenticator key allows forging valid ciphertext tags for arbitrary messages).

In LumaLink, optical channels experience packet duplication (the camera repeatedly frames the same displayed QR symbol) and packet reordering. Furthermore, control messages and data messages share the session context, and future two-way optical channels will introduce reverse-direction messages (receiver $\to$ sender).

Nonces must therefore be deterministic, mathematically disjoint across message domains and flow directions, and paired with domain-isolated replay protection.

---

## Decision: Structured 96-Bit Nonce with Domain & Direction Separation

Rather than drawing random nonces (which risk birthday bound collisions in high-symbol transfers), LumaLink employs a **deterministic, structured 96-bit nonce** bound to the message domain, direction, session context, and packet sequence:

```text
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  Domain Tag   |               Salt Prefix (3 bytes)           |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                    Block Index (4 bytes BE)                   |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|               Symbol ID / Sequence Number (4 bytes BE)        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

### Nonce Field Breakdown:

1. **Byte 0 (Domain Tag)**:
   - **Bit 7 (Direction Bit)**:
     - `0` = Sender $\to$ Receiver (Outbound broadcast / transmission)
     - `1` = Receiver $\to$ Sender (Inbound control / reverse channel)
   - **Bits 6..4**: Reserved (`000b`)
   - **Bits 3..0 (Packet Type Code)**:
     - `0x01` = MANIFEST (`PacketTypeCode.MANIFEST = 1`)
     - `0x02` = DATA (`PacketTypeCode.DATA = 2`)
     - `0x03` = SYNC (`PacketTypeCode.SYNC = 3`)
     - `0x04` = CONTROL (`PacketTypeCode.CONTROL = 4`)

   Specific tag examples:
   - `0x02`: Sender DATA packet
   - `0x04`: Sender CONTROL packet
   - `0x82`: Receiver DATA packet
   - `0x84`: Receiver CONTROL packet

2. **Bytes 1..3 (Salt Prefix)**:
   - 3 bytes derived via HKDF key expansion (`info = "LumaLink-*-Nonce-Salt"`).
   - Cryptographically binds the nonce to the session master secret and session ID.

3. **Bytes 4..7 (Block Index)**:
   - 32-bit unsigned Big-Endian integer identifying the source block ($0 \le \text{blockIndex} < 2^{32}$).

4. **Bytes 8..11 (Symbol ID / Sequence Number)**:
   - 32-bit unsigned Big-Endian integer identifying the Encoding Symbol Identifier (ESI) or control message counter ($0 \le \text{symbolId} < 2^{32}$).

---

### Mathematical Proof of Nonce Disjointness

For any two packets $P_1 = (dir_1, type_1, b_1, s_1)$ and $P_2 = (dir_2, type_2, b_2, s_2)$:

- **Case 1: Different Directions ($dir_1 \ne dir_2$)**
  Bit 7 of Byte 0 differs ($0$ vs $1$). Therefore, $\text{Nonce}_1[0] \ne \text{Nonce}_2[0]$ and the nonces can never collide.

- **Case 2: Different Domains ($type_1 \ne type_2$)**
  Bits 3..0 of Byte 0 differ. Therefore, $\text{Nonce}_1[0] \ne \text{Nonce}_2[0]$ (e.g. DATA `0x02` vs CONTROL `0x04`).

- **Case 3: Same Direction and Domain ($dir_1 = dir_2$, $type_1 = type_2$)**
  If $b_1 \ne b_2$, Bytes 4..7 differ.
  If $s_1 \ne s_2$, Bytes 8..11 differ.
  If $(b_1, s_1) = (b_2, s_2)$, this would represent an illegal duplicate generation under the same key. `NonceManager` tracks generated keys (`direction:type:b:s`) and raises a `SecurityError` preventing reuse.

Hence, AEAD nonce spaces are **strictly and mathematically disjoint**.

---

## Associated Authenticated Data (AAD) Binding

To prevent cross-session splicing, block injection, or type manipulation attacks, every AEAD encryption operation cryptographically binds the packet header fields into the Poly1305 authentication tag via Associated Authenticated Data:

$$AAD = \text{SessionId (16B)} \parallel \text{BlockIndex (4B)} \parallel \text{SymbolId (4B)} \parallel \text{PacketType (1B)} \parallel \text{Flags (1B)}$$

If an adversary alters the session ID, swaps the packet into another block, or alters the packet flags, Poly1305 verification fails immediately, discarding the packet.

---

## Replay Domain Separation (`ReplayProtector`)

Optical camera transport inherently produces duplicate packet reads. Replay protection is separated by domain and direction:

$$\text{Replay Cache Key} = \text{direction} \parallel \text{packetTypeCode} \parallel \text{blockIndex} \parallel \text{symbolId}$$

- **No Cross-Domain Blocking**: A control packet at $(0, 0)$ (`sender:4:0:0`) does NOT block a data symbol at $(0, 0)$ (`sender:2:0:0`).
- **No Direction Collision**: Inbound control packets do not collide with outbound packets.
- **Out-of-Order Support**: Fountain coding relies on receiving novel symbols in arbitrary arrival order; any novel $(b, s)$ within the domain is accepted, while replayed duplicates are dropped.

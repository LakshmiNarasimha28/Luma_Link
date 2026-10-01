# Phase 1: Protocol Core & Loss-Resilient Transfer Architecture

## 1. Overview

Phase 1 establishes the core transport, forward error correction (FEC), and packet serialization pipeline of LumaLink entirely in software. It demonstrates that an arbitrary byte sequence can be partitioned, encoded with rateless fountain symbols, transmitted across a simulated lossy/reordered/duplicated channel, and reassembled with bit-for-bit SHA-256 verification.

---

## 2. Pipeline Hierarchy: File → Block → Symbol

Data flows through three granularities of decomposition:

$$\text{User File} \longrightarrow \text{Source Blocks} \longrightarrow \text{Source Symbols} \longrightarrow \text{LT Encoded Symbols} \longrightarrow \text{Transport Packets}$$

1. **User File**: Arbitrary binary data. Length is explicitly preserved in the file manifest.
2. **Source Block**: Contiguous partitions of the file. Partitioning large files into bounded blocks prevents unbounded memory consumption and keeps the decoder graph within optimal matrix sizes ($K \le 1024$).
3. **Source Symbol**: Uniform slices of size $S$ bytes (default: 256 bytes) within each block. A block contains $K$ source symbols (default: 64 symbols $\implies$ 16 KB per block). The final symbol of the final block is zero-padded to maintain uniform dimensions; this padding is discarded during file reassembly.
4. **LT Encoded Symbol**: Linear combination of $d$ source symbols computed via bitwise XOR ($\bigoplus$).
5. **Transport Packet**: 42-byte binary header + symbol payload with CRC32 integrity detection.

---

## 3. Luby Transform (LT) Fountain Coding

LumaLink implements the canonical Luby Transform (LT) rateless erasure code.

### 3.1 Deterministic Randomness (`Prng`)

Fountain coding requires that sender and receiver agree on which source symbols were combined to form any given encoded symbol.

- Implemented using the **Mulberry32** pseudo-random generator.
- Deterministic 32-bit state: given identical seeds, generator produces identical outputs.
- Zero reliance on global mutable state or `Math.random()`.
- Seed derivation: $\text{seed}(b, s) = \text{Mix32}(b, s)$ ensures that every symbol index in every block has a distinct, reproducible PRNG sequence.

### 3.2 Degree Distribution (`RobustSolitonDistribution`)

The degree $d \in [1, K]$ is sampled from the **Robust Soliton Distribution** $\mu(d) = \frac{\rho(d) + \tau(d)}{\beta}$:

- **Ideal Soliton $\rho(d)$**: Ensures that the expected number of degree-1 symbols (the ripple) is 1 at each peeling step:
  $$\rho(1) = \frac{1}{K}, \quad \rho(d) = \frac{1}{d(d - 1)} \text{ for } d = 2 \dots K$$
- **Spike Component $\tau(d)$**: Adds redundancy to ensure the ripple does not die out prematurely (stalling):
  $$R = c \ln(K / \delta)\sqrt{K}$$
  $$\tau(d) = \begin{cases} \frac{R}{d \cdot K} & \text{for } 1 \le d < \lfloor K/R \rfloor \\ \frac{R \ln(R/\delta)}{K} & \text{for } d = \lfloor K/R \rfloor \\ 0 & \text{for } d > \lfloor K/R \rfloor \end{cases}$$
- Default parameters: $c = 0.1$, $\delta = 0.05$.
- CDF precomputed for $O(\log K)$ inverse-transform sampling.

### 3.3 Peeling Decoder (`LtDecoder`)

Decoding operates via iterative linear substitution:

1. When an encoded symbol arrives, already-recovered source symbols are XORed out.
2. If the remaining degree is 1, the equation is pushed to a **ripple queue**.
3. If degree $> 1$, the equation is stored in the equation pool and indexed by its unresolved source neighbors.
4. The peeling loop pops degree-1 equations from the ripple, recovers source symbols, cancels them from dependent equations, and continues until all $K$ symbols are solved or the ripple empties (`stalled`).

---

## 4. Transport Packet Binary Model

Packets are serialized into a fixed 42-byte Big-Endian header followed by raw payload bytes:

| Byte Offset | Field            | Type        | Description                                              |
| :---------- | :--------------- | :---------- | :------------------------------------------------------- |
| `0..3`      | Magic            | `ASCII`     | Protocol identifier: `'LUMA'` (`0x4c, 0x55, 0x4d, 0x41`) |
| `4`         | Version          | `uint8`     | Protocol version (`0x01`)                                |
| `5`         | PacketType       | `uint8`     | Type code: `1=MANIFEST, 2=DATA, 3=SYNC, 4=CONTROL`       |
| `6`         | Flags            | `uint8`     | Control flags                                            |
| `7`         | Reserved         | `uint8`     | Alignment / reserved                                     |
| `8..23`     | SessionId        | `16 bytes`  | UUID / Transfer identifier                               |
| `24..27`    | BlockIndex       | `uint32 BE` | 0-indexed source block index                             |
| `28..31`    | SymbolId         | `uint32 BE` | Encoding Symbol Identifier (ESI)                         |
| `32..33`    | TotalSymbols (K) | `uint16 BE` | Source symbols in this block                             |
| `34..35`    | Degree           | `uint16 BE` | Equation degree ($d$)                                    |
| `36..37`    | PayloadLength    | `uint16 BE` | Byte length of payload ($N$)                             |
| `38..41`    | Checksum         | `uint32 BE` | IEEE 802.3 CRC-32 over header + payload                  |
| `42..`      | Payload          | `N bytes`   | Encoded symbol data                                      |

### Strict Validation Rules

- Rejection of mismatched magic headers (`MalformedPacketError`).
- Rejection of unsupported protocol versions (`UnsupportedProtocolVersionError`).
- Rejection of invalid packet type codes (`InvalidPacketTypeError`).
- Detection and rejection of truncated frames (`TruncatedPacketError`).
- Strict rejection of trailing bytes unless explicitly configured (`TrailingDataError`).
- Bit-flip detection via CRC-32 checksum (`ChecksumMismatchError`).

---

## 5. Packet Deduplication (`PacketDeduplicator`)

The simplex optical channel will inherently produce duplicate symbols due to high-FPS camera sampling. The deduplicator maintains a seen set keyed on:
$$\text{Key} = \text{SessionId} : \text{BlockIndex} : \text{SymbolId}$$
Duplicates are dropped prior to updating the decoding graph, preserving memory and CPU cycles.

---

## 6. Simulated Transport Channel (`SimulatedChannel`)

Validates pipeline robustness against physical airgap optical channel characteristics without camera hardware:

- **Packet Loss**: Simulates frame drops from camera motion blur or glare.
- **Packet Duplication**: Simulates multiple camera video frames capturing the same displayed screen frame.
- **Packet Reordering**: Simulates multi-threaded frame processing or async decoder scheduling.

---

## 7. Reassembly & End-to-End SHA-256 Verification

Once all blocks for a transfer are reconstructed:

1. Blocks are ordered $[0 \dots \text{totalBlocks}-1]$.
2. Padding bytes on the final block are sliced off using `manifest.fileSize`.
3. The SHA-256 digest of the reconstructed bytes is computed using Node's standard `node:crypto`.
4. The digest is compared against `manifest.sha256Digest`. If mismatched, a `Sha256MismatchError` is raised.

---

## 8. Known Limitations in Phase 1

- **Software Simulation Only**: Optical camera transport, screen rendering, and QR/matrix codecs are intentionally not implemented.
- **No Cryptographic AEAD**: Payload encryption and cryptographic signature verification belong to Phase 2.
- **Fountain Overhead**: Standard LT coding requires a modest overhead factor ($\approx 1.2\times$ to $2.0\times$ $K$) to overcome random degree graph stalls compared to systematic RaptorQ codes (slated for later evaluation).

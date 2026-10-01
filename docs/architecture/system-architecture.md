# LumaLink System Architecture

## Overview

LumaLink is a secure, offline optical file-transfer system designed to transmit data across air-gapped environments using screen-to-camera visible-light communication (VLC).

The architecture is built upon a modular, layered foundation that enforces strict separation of concerns among the protocol, transport, forward error correction (FEC), security, visual encoding, and platform presentation layers.

---

## End-to-End Pipeline

The end-to-end data lifecycle flows through symmetric sender and receiver pipelines:

```text
SENDER PIPELINE                               RECEIVER PIPELINE
================                              =================
USER FILE                                     VERIFIED FILE
   ↓                                             ↑
FILE PREPROCESSING                            SHA-256 VERIFICATION
   ↓                                             ↑
SESSION MANAGER                               FILE REASSEMBLY
   ↓                                             ↑
SECURITY (Key Agreement / AEAD)               DECRYPTION
   ↓                                             ↑
SOURCE BLOCKS                                 FEC DECODER
   ↓                                             ↑
FEC / FOUNTAIN CODING                         PACKET VALIDATION
   ↓                                             ↑
TRANSPORT PACKETS                             VISUAL DECODER
   ↓                                             ↑
VISUAL CODEC (e.g. QR / Matrix)               CAMERA CAPTURE
   ↓                                             ↑
DISPLAY                                       OPTICAL CHANNEL
   └─────────────────── Optical Airgap ──────────┘
```

---

## Core Abstractions

Data is transformed across precise boundary units:

$$\text{File} \longrightarrow \text{Block} \longrightarrow \text{Source Symbol} \longrightarrow \text{FEC Symbol} \longrightarrow \text{Transport Packet} \longrightarrow \text{Visual Frame}$$

1. **File**: Raw uncompressed or preprocessed byte stream with file metadata (name, MIME type, size, SHA-256 hash).
2. **Block**: A contiguous slice of the file. Large files are partitioned into multiple source blocks to bound memory overhead and decoder complexity.
3. **Source Symbol**: Equal-sized chunks partitioned from a source block.
4. **FEC Symbol**: Mathematical encoding symbols produced by the FEC/fountain encoder (source symbols plus erasure/repair symbols).
5. **Transport Packet**: Serialized protocol data unit containing packet type, session ID, block index, sequence number, payload (FEC symbol), and checksum.
6. **Visual Frame**: The visual 2D representation (e.g. QR code or matrix barcode) rendered on screen or captured by camera.

---

## Key Architectural Principles

### 1. Separation of Protocol Core and Platform Presentation

The core protocol logic resides exclusively in `@lumalink/core` and remains strictly independent of any presentation layer, UI framework, or native device APIs.

- **Zero React / React Native dependencies**: The core is implemented in pure TypeScript and runs under standard Node.js environments.
- **Platform-Agnostic Execution**: The core can be executed in headless environments, CLI utilities, test runners, or mobile JS runtimes without modification.
- **Dependency Inversion**: Rather than the core calling platform APIs (camera, filesystem, hardware acceleration), platforms instantiate and drive the core using abstract interfaces (e.g., `StorageDriver`).

### 2. Protocol vs. Visual Codec Separation

A critical design requirement is that **a QR code is a visual codec, not the transport protocol**.

- The transport protocol defines sessions, block indexing, packet sequencing, integrity verification, and payload delivery.
- The visual codec is a swappable adapter that converts raw byte packets into displayable images and decodes images back into byte packets.
- QR codes, Aztec codes, or high-density custom color matrices can be substituted without altering the packet structure, session logic, or FEC pipeline.

### 3. Pluggable Forward Error Correction (FEC)

Optical transmission over screen-to-camera links experiences packet erasures (dropped frames due to motion blur, glare, frame skips, or partial occlusions).

To handle loss resilience without requiring a return channel (simplex broadcast), LumaLink relies on erasure coding:

- **Pluggable Abstraction**: The core exposes `FecEncoder` and `FecDecoder` interfaces.
- **Evolutionary Roadmap**: Initial experimentation begins with parity/XOR, progressing to rateless fountain codes (Luby Transform) and Raptor/RaptorQ codes.
- The rest of the transport layer operates purely on abstract `FecSymbol` instances.

### 4. Conservative Security Architecture

Security is baked into the transport rather than treated as an afterthought:

- Authenticated and encrypted channels using established primitives (X25519, HKDF, AEAD).
- Support for **Quick Send** (unencrypted or authenticated open broadcast) and **Private Send** (authenticated, end-to-end encrypted session).
- Replay protection and duplicate symbol detection built into packet validation.

---

## Future Mobile Architecture (`apps/mobile`)

The mobile client will be implemented in React Native, acting as a consumer of `@lumalink/core`:

- **UI / State Management**: Manages user interactions (selecting files, displaying QR stream, camera viewfinder, progress bars).
- **Native Camera Bridge**: Interfaces with native Android (CameraX) and iOS (AVFoundation) camera pipelines for high-framerate visual frame acquisition.
- **Native Render Bridge**: High-performance canvas or surface rendering to cycle visual frames at steady display refresh rates (e.g., 30–60 FPS).
- **Core Integration**: Feeds raw decoded frame buffers into the core's packet validator and receives reassembled, verified files upon completion.

# LumaLink

> **Secure Offline Optical File Transfer**

LumaLink is a research and engineering project for secure file transfer across an air-gapped environment using **screen-to-camera visible-light communication (VLC)**.

Instead of Wi-Fi, Bluetooth, or physical cables, a transmitting device renders encoded data as visual frames on a display and a receiving device captures those frames with a camera.

The system is designed around a layered protocol architecture so that the transport, reliability, security, and file-transfer logic remain independent of the underlying visual codec.

---

## 1. Project Overview

LumaLink explores a complete optical communication pipeline:

```text
                    LumaLink
                       │
                       ▼
                  USER FILE
                       │
                       ▼
              FILE PREPROCESSING
                       │
                       ▼
             SESSION ESTABLISHMENT
                       │
             ┌─────────┴─────────┐
             │                   │
        CONTROL PLANE        DATA PLANE
             │                   │
       ┌─────┴─────┐       ┌─────┴─────┐
       │           │       │           │
    MANIFEST   KEY ENVELOPE       FEC DATA
       │           │               │
       └─────┬─────┘               │
             │                     │
             └─────────┬───────────┘
                       ▼
                    SECURITY
                 X25519 / HKDF
                 ChaCha20-Poly1305
                       │
                       ▼
                SOURCE BLOCKS
                       │
                       ▼
                FOUNTAIN / LT FEC
                       │
                       ▼
               TRANSPORT PACKETS
                       │
                       ▼
                 VISUAL CODEC
                 QR BASELINE
                       │
                       ▼
                    DISPLAY
                       │
                       ▼
              OPTICAL CHANNEL
             SCREEN → CAMERA
                       │
                       ▼
                    CAMERA
                       │
                       ▼
               VISUAL DECODER
                       │
                       ▼
              PACKET VALIDATION
                 CRC / replay
                       │
                       ▼
              AUTHENTICATED DATA
                       │
                       ▼
                  FEC DECODER
                       │
                       ▼
                FILE REASSEMBLY
                       │
                       ▼
                  SHA-256
                  VERIFICATION
                       │
                       ▼
                 VERIFIED FILE
```

### Architectural principle

**QR is a visual codec, not the transport protocol.**

The transport protocol, packet format, FEC layer, security layer, and session management are designed to operate independently of a particular visual encoding. This allows future visual codecs to be evaluated without redesigning the underlying transfer protocol.

---

## 2. Why Optical Transfer?

LumaLink explores screen-to-camera visible-light communication as an alternative physical channel for offline file transfer.

The current system provides:

- Direct screen-to-camera transmission
- Line-of-sight communication
- No Wi-Fi dependency
- No Bluetooth dependency
- No physical cable
- Explicit software-level integrity verification

The project is an engineering and research platform, not a claim that optical transfer is universally superior to RF-based technologies.

---

## 3. Current Development Status

### Phase 6 — Dynamic Session Establishment & Physical Validation

The project has progressed from a software-only protocol foundation to a physically validated end-to-end optical transfer pipeline.

Completed major phases:

| Phase | Status | Major capability |
|---|---|---|
| Phase 0 | Complete | Project foundation and architecture |
| Phase 1 | Complete | Transport protocol, packetization and LT/FEC simulation |
| Phase 2 | Complete | X25519, HKDF, ChaCha20-Poly1305 and session security |
| Phase 3 | Complete | Pluggable visual codec layer and QR baseline |
| Phase 4 | Complete | Physical screen-to-camera optical channel |
| Phase 5A | Complete | Portable core and real-file E2E pipeline |
| Phase 5B | Complete | Real sender → QR optical pipeline |
| Phase 5C | Complete | Android packet receiver, crypto, FEC, reassembly and SHA-256 |
| Phase 6 | Complete | Dynamic manifest, key-envelope control protocol and physical E2E validation |

### Current demonstrated pipeline

```text
MANIFEST
   ↓
KEY ENVELOPE
   ↓
AUTHENTICATED DATA
   ↓
LT / FOUNTAIN DECODING
   ↓
FILE REASSEMBLY
   ↓
SHA-256 VERIFICATION
   ↓
VERIFIED FILE
```

The physical validation has been performed using a Samsung Galaxy M04 receiver with a desktop display acting as the optical sender.

---

## 4. Security Architecture

LumaLink uses authenticated encryption rather than treating optical visibility as a security mechanism.

### Cryptographic components

- **X25519** — elliptic-curve key agreement
- **HKDF-SHA256** — key derivation
- **ChaCha20-Poly1305** — authenticated encryption
- **SHA-256** — final file integrity verification
- **CRC-32** — transport-packet corruption detection
- replay protection and packet deduplication

### Quick Send

Quick Send uses a randomly generated broadcast encryption key and per-receiver key envelopes.

### Private Send

Private Send introduces explicit receiver authorization as part of the session-control model.

The current physical implementation validates the control/key-envelope processing path, while a complete interactive physical approval workflow remains future work.

### Security boundary

The current protocol provides encryption, authentication of encrypted payloads, replay protection, and authorization mechanisms.

It does **not** currently provide complete active man-in-the-middle protection against an attacker capable of replacing the session's public-key material. Strong device identity authentication / SAS-style verification remains future work.

---

## 5. Reliability Architecture

Optical channels are inherently vulnerable to:

- camera frame drops
- QR decode misses
- motion blur
- focus changes
- display/camera timing differences
- glare
- viewing angle
- distance
- temporary occlusion

LumaLink therefore does not rely on every transmitted frame being received.

The current protocol uses **LT fountain coding** so that receivers can reconstruct a source block from a sufficient set of independently received symbols.

The architecture keeps FEC independent from the optical codec:

```text
Source Blocks
      ↓
Fountain Encoder
      ↓
Transport Packets
      ↓
Visual Codec
      ↓
Optical Channel
      ↓
Visual Decoder
      ↓
Transport Packets
      ↓
Fountain Decoder
      ↓
Source Blocks
```
---

## 6. Protocol Architecture

The system separates the **control plane** from the **data plane**.

### Control plane

Responsible for establishing the session:

```text
MANIFEST
    ↓
Session metadata
    ↓
KEY ENVELOPE / CONTROL
    ↓
Session security context
```

The manifest contains information such as:

- protocol version
- security mode
- session ID
- timestamp
- file size
- block configuration
- symbol configuration
- sender public key
- SHA-256 digest
- sender device ID
- filename

### Data plane

After the session is established:

```text
FEC Symbol
   ↓
TransportPacket
   ↓
CRC
   ↓
Visual Encoding
   ↓
Optical Transmission
```

The receiver validates, authenticates, deduplicates and feeds valid symbols into the FEC decoder.

---

## 7. Physical Optical Channel

The current physical baseline uses:

- desktop display as sender
- Android device as receiver
- CameraX for camera acquisition
- ZXing for QR decoding
- QR Byte Mode
- binary payloads rather than Base64/hex encoding
- camera Y-plane processing
- `KEEP_ONLY_LATEST` frame strategy
- ROI-based decoding
- display-side frame carousel

The current physical implementation is intentionally conservative and uses QR as the baseline visual codec.

Future work may evaluate higher-density and adaptive visual codecs, including multi-QR, color-grid, and custom visual symbologies.

---

## 8. Validation

The project has been validated at multiple levels.

### Software validation

The TypeScript core and Android harness include automated tests covering their respective protocol, security, FEC, and transfer components:

- Packet encoding/decoding and CRC validation
- LT/FEC encoding and decoding
- Deduplication and replay protection
- X25519, HKDF and ChaCha20-Poly1305
- Manifest and control protocols
- File reassembly and SHA-256 verification
- Simulated loss, duplication and reordering

The Android harness includes corresponding validation for:

- QR byte extraction
- transport packet parsing
- CRC validation
- X25519
- HKDF
- ChaCha20-Poly1305
- nonce construction
- AAD construction
- replay protection
- LT decoding
- dynamic manifest handling
- key-envelope processing
- file reconstruction

At the Phase 6 checkpoint:

- TypeScript: 181/181 tests passing
- Android: 180/180 tests passing
- Android Phase 5 regression suites: 121/121 passing
- TypeScript typecheck, lint and build: passing
- Android assemble and lint: passing

### Physical validation

The physical Phase 6 validation demonstrated:

```text
PC Display
    ↓
QR Visual Frames
    ↓
Samsung Galaxy M04 Camera
    ↓
ZXing BYTE_SEGMENTS
    ↓
Transport Packet
    ↓
CRC Validation
    ↓
Dynamic Manifest
    ↓
Key Envelope
    ↓
AEAD Decryption
    ↓
LT/FEC Reconstruction
    ↓
File Reassembly
    ↓
SHA-256
    ↓
Exact Digest Match
```

Physical validation: A 1 KiB test file completed the full optical pipeline and produced the expected SHA-256 digest:

```text
3bbd161d7b3e0cb9df602fb2f2e51aef0eec260451cf1fc327e5ecbe2199b418
```

> Note: physical loss experiments and simulated-loss experiments are tracked separately. Simulated packet loss is used for deterministic protocol testing; natural physical frame skips and QR decode misses arise from the real optical channel.

---

## 9. Current Physical Performance Baseline

Under the tested desktop-display → Samsung M04 setup, the Phase 6 validation observed approximately:

| Metric | Observed range |
|---|---:|
| Camera arrival rate | 20–30 FPS |
| QR decode rate | 7.4–11.8 frames/s |
| L1 decode throughput | ~1200–1800 B/s |
| L2 optical-channel goodput | ~450–720 B/s |
| L3 verified end-to-end goodput | ~85–140 B/s |
| Total test transfer | ~7.5–12 s |

These numbers are **baseline measurements for the tested hardware, display, camera configuration and QR parameters**, not universal performance guarantees.

---

## 10. Technology Stack

### Core

- TypeScript
- pnpm workspaces
- Vitest
- ESLint
- Prettier

### Android optical harness

- Kotlin
- Android CameraX
- Android Camera2 interoperability
- ZXing
- Android JCA / AndroidOpenSSL cryptography

### Cryptography

- X25519
- HKDF-SHA256 implemented using HMAC-SHA256
- ChaCha20-Poly1305
- SHA-256

### Research

- Python
- optical-channel experiments
- FEC experiments
- benchmark analysis
- future ML/optimization research

### Future application layer

React Native and additional native platform integrations remain future work.

---

## 11. Repository Structure

```text
Luma_Link/
├── apps/
│   ├── mobile/                  # Future cross-platform application
│   └── android-harness/         # Android optical sender/receiver harness
│
├── packages/
│   └── core/                    # Shared TypeScript protocol core
│       ├── src/
│       │   ├── channel/
│       │   ├── fec/
│       │   ├── optical/
│       │   ├── packet/
│       │   ├── protocol/
│       │   ├── security/
│       │   ├── session/
│       │   ├── storage/
│       │   └── transfer/
│       └── test/
│
├── research/                    # Research experiments and analysis
├── benchmarks/                  # Protocol and optical benchmarks
├── tests/                       # Workspace-level integration tests
│
├── docs/
│   ├── architecture/            # Architecture documentation
│   ├── decisions/               # Architecture Decision Records
│   ├── experiments/             # Experimental validation reports
│   └── research/                # Research notes
│
├── scripts/                     # Development and benchmark scripts
├── .github/workflows/           # CI
│
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.json
└── README.md
```

---

## 12. Development

### Prerequisites

- Node.js 24+
- pnpm 12+
- Python 3.12+
- Git 2+

### Install

```bash
git clone https://github.com/LakshmiNarasimha28/Luma_Link.git
cd Luma_Link
pnpm install
```

### Core checks

```bash
pnpm test
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run build
```

The Android harness is built separately using the Gradle/Android project under `apps/android-harness`.

---

## 13. Current Limitations

The current implementation is intentionally not presented as a finished consumer file-sharing application.

Known limitations include:

- physical optical communication is currently **simplex**
- the Phase 6 physical key-envelope transmission uses a pre-arranged test setup
- dynamic session establishment is validated in software/JVM and integrated into the receiver architecture
- complete physical Private Send approval interaction is not yet implemented
- strong device-identity authentication / SAS is deferred
- QR is currently the baseline visual codec
- adaptive/custom high-density visual codecs are future work
- the Android harness is a validation platform, not yet the final production mobile UX
- React Native application integration is future work
- optical goodput remains substantially lower than conventional RF file-transfer technologies under the current QR baseline

---

## 14. Roadmap

Completed:

- [x] Project foundation
- [x] Protocol and packet core
- [x] LT fountain coding
- [x] Session security
- [x] QR visual codec baseline
- [x] Physical optical channel
- [x] Portable TypeScript core
- [x] Real sender pipeline
- [x] Android packet receiver
- [x] Android cryptographic integration
- [x] Android FEC decoding
- [x] File reassembly and SHA-256 verification
- [x] Dynamic manifest protocol
- [x] Dynamic session security establishment
- [x] Physical end-to-end validation

### Future work

- Bidirectional control channel and complete physical Private Send authorization
- Stronger device identity authentication
- Adaptive and higher-density visual codecs
- Systematic fountain-code evaluation
- Improved camera/decoder tracking and ROI strategies
- Larger-file streaming and resumability
- Production mobile application integration
- Cross-platform optical transfer
- ML-assisted channel adaptation where justified by measurement.
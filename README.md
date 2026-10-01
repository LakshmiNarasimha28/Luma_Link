# LumaLink

> **Secure Offline Optical File Transfer**

LumaLink is a production-grade offline optical file-transfer system that uses screen-to-camera visible-light communication (VLC) to transmit files securely across air-gapped environments without Wi-Fi, Bluetooth, or physical cables.

---

## 1. Project Description

LumaLink bridges physical isolation barriers using optical signals. By rendering animated, high-density 2D visual frames (such as QR codes or matrix symbols) on a transmitting screen and capturing them with a receiving device's camera, LumaLink enables unidirectional (simplex) file broadcasts and secure point-to-point transfers.

The system incorporates forward error correction (FEC) / fountain coding to ensure complete, verified reconstruction of files even when optical frames are dropped or corrupted by ambient glare, blur, or frame drops.

---

## 2. Problem Statement

Existing offline file-sharing solutions (AirDrop, Quick Share, Bluetooth) rely on RF (radio frequency) wireless channels. These channels present significant drawbacks in high-security, regulated, or hostile environments:

- **RF Emanation & Leakage**: Wireless transmissions can be intercepted, direction-found, or jammed.
- **Protocol Vulnerabilities**: Complex wireless protocol stacks (Bluetooth, Wi-Fi Direct) introduce broad attack surfaces.
- **Air-Gap Violations**: In classified or secured operational centers, RF-enabled devices are strictly prohibited.

LumaLink addresses this challenge by utilizing the visible-light spectrum for direct line-of-sight data transfer, providing directional control, visual auditability, and zero radio frequency footprint.

---

## 3. High-Level Architecture

The system is organized into modular layers with strict separation of concerns:

```text
USER FILE
    ↓
FILE PREPROCESSING (Metadata, Chunking, SHA-256)
    ↓
SESSION MANAGER (Sender / Receiver Lifecycle)
    ↓
SECURITY (Key Agreement, HKDF, AEAD)
    ↓
SOURCE BLOCKS (Bounded memory partitions)
    ↓
FEC / FOUNTAIN CODING (Erasure resilience)
    ↓
TRANSPORT PACKETS (Framing, sequence numbers, checksums)
    ↓
VISUAL CODEC (QR / 2D Matrix Symbol generation)
    ↓
DISPLAY (High-FPS animated stream)
    ↓
OPTICAL CHANNEL (Screen-to-Camera Airgap)
    ↓
CAMERA (High-speed frame capture)
    ↓
VISUAL DECODER (Symbol extraction & error correction)
    ↓
PACKET VALIDATION (CRC / Integrity verification)
    ↓
FEC DECODER (Fountain symbol accumulation & block solve)
    ↓
DECRYPTION (AEAD payload decryption)
    ↓
FILE REASSEMBLY (Block concatenation)
    ↓
SHA-256 VERIFICATION (End-to-end integrity check)
    ↓
VERIFIED FILE
```

### Core Abstraction Hierarchy

$$\text{File} \longrightarrow \text{Block} \longrightarrow \text{Source Symbol} \longrightarrow \text{FEC Symbol} \longrightarrow \text{Transport Packet} \longrightarrow \text{Visual Frame}$$

> **Important Architectural Rule**: A QR code is a visual codec, not the transport protocol. The transport and protocol layers operate independently of any specific visual encoding.

---

## 4. Current Development Status

- **Active Phase**: **Phase 0 — Project Foundation**
- **Optical / Camera Status**: **Not implemented yet.**
- Current capabilities:
  - pnpm monorepo structure with `@lumalink/core` package.
  - Strict TypeScript configuration.
  - Pluggable architectural boundaries for protocol, packet, FEC, security, session, transfer, and storage.
  - Automated testing via Vitest.
  - Code formatting with Prettier and linting with ESLint.
  - Minimal CI workflow for GitHub Actions.

---

## 5. Technology Stack

- **Core & Protocol Logic**: TypeScript (Node.js & cross-platform JavaScript engines)
- **Mobile Client (Future)**: React Native (`apps/mobile`)
- **Native Platform APIs (Future)**: Android (Kotlin / CameraX) and iOS (Swift / AVFoundation) for camera sensor pipelines
- **Research & Modeling**: Python 3.12 (`research/`) for optical channel modeling, synthetic noise, and mathematical FEC simulations
- **Package Manager**: pnpm (workspaces)
- **Test Framework**: Vitest
- **Tooling**: ESLint, Prettier, TypeScript compiler (`tsc`)

---

## 6. Repository Structure

```text
luma_link/
├── apps/
│   └── mobile/             # Cross-platform React Native mobile client (future)
├── packages/
│   └── core/               # Shared protocol, packet, FEC, security, and session core (@lumalink/core)
│       ├── src/
│       │   ├── protocol/   # Protocol constants, headers, and capabilities
│       │   ├── packet/     # Transport packet framing and codecs
│       │   ├── fec/        # Pluggable Forward Error Correction interfaces
│       │   ├── security/   # Cryptographic contexts and AEAD boundaries
│       │   ├── session/    # Session lifecycle and state machines
│       │   ├── transfer/   # File preprocessing and progress tracking
│       │   └── storage/    # Pluggable storage driver interfaces
│       └── test/           # Core unit tests
├── research/               # Python simulations and channel modeling
├── benchmarks/             # Goodput and FEC throughput benchmarks
├── tests/                  # Workspace integration and end-to-end tests
├── docs/
│   ├── architecture/       # Detailed architecture documents
│   ├── decisions/          # Architecture Decision Records (ADRs)
│   └── research/           # Research notes and literature reviews
├── scripts/                # Repository maintenance and development scripts
├── .github/
│   └── workflows/          # GitHub Actions CI pipelines
├── package.json            # Monorepo root configuration
├── pnpm-workspace.yaml     # Workspace package definitions
├── tsconfig.json           # Root TypeScript configuration
└── README.md
```

---

## 7. Development Setup

### Prerequisites

- Node.js >= 24.x
- pnpm >= 12.x
- Python >= 3.12 (for research/scripts)
- Git >= 2.x

### Installation

Clone the repository and install workspace dependencies:

```bash
git clone https://github.com/LakshmiNarasimha28/Luma_Link.git
cd Luma_Link
pnpm install
```

---

## 8. Available Commands

| Command                 | Description                                               |
| :---------------------- | :-------------------------------------------------------- |
| `pnpm install`          | Install all monorepo dependencies                         |
| `pnpm run build`        | Compile TypeScript packages (`@lumalink/core`) to `dist/` |
| `pnpm run typecheck`    | Run strict typechecking across all workspace packages     |
| `pnpm run test`         | Run all unit and integration test suites using Vitest     |
| `pnpm run lint`         | Check code for style and lint violations using ESLint     |
| `pnpm run lint:fix`     | Automatically fix ESLint violations                       |
| `pnpm run format`       | Format the entire codebase using Prettier                 |
| `pnpm run format:check` | Verify formatting across all files without modifying      |

---

## 9. Roadmap

- [x] **Phase 0: Project Foundation** (Monorepo, TypeScript configuration, module boundaries, CI, documentation)
- [ ] **Phase 1: Protocol Core & Simulation** (Packet codecs, file chunking, session state machines, test harnesses)
- [ ] **Phase 2: Security & Authentication** (X25519 key agreement, HKDF, AEAD authenticated encryption, Private Send)
- [ ] **Phase 3: Forward Error Correction (FEC)** (Pluggable fountain coding, erasure resilience)
- [ ] **Phase 4: Visual Codec Layer** (2D matrix generation, frame sequencing, viewport synchronization)
- [ ] **Phase 5: Mobile Application & Camera Transport** (React Native UI, native camera capture, optical link execution)
- [ ] **Phase 6: Performance Optimization & Goodput Tuning** (Frame rate adaptation, benchmark validation)

---

## 10. Current Limitations

- **No Optical / Camera Code**: Optical transmission, QR generation, camera preview, and frame capture are deliberately omitted in this phase.
- **Interfaces Only**: Core modules provide structural interfaces and type definitions; algorithm implementations (FEC solvers, crypto primitives, packet encoders) are scheduled for subsequent phases.
- **Simulated Environment**: Current verification is limited to unit and workspace integration tests running in Node.js.

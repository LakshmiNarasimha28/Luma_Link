# ADR-002: Cryptographic Primitives & Library Selection

## Status

Accepted

## Date

2026-10-01

## Context

LumaLink requires a production-grade cryptographic subsystem to support:

1. **Key Agreement**: Establishing shared secrets across airgapped optical sessions.
2. **Key Derivation**: Expanding shared secrets into distinct, cryptographically isolated session keys (encryption key and structured nonce salt).
3. **Authenticated Encryption with Associated Data (AEAD)**: Protecting payload confidentiality and verifying authenticity and integrity without separate MAC tags.
4. **Platform Portability**: The initial core runs in Node.js, but the long-term architecture targets mobile JavaScript runtimes (React Native / Hermes) and desktop environments without altering the transport core.

## Decision

1. **Cryptographic Primitives**:
   - **Key Agreement**: **X25519** (Curve25519 Montgomery form, RFC 7748). 128-bit security level, immune to timing side-channels, compact 32-byte keys.
   - **Key Derivation**: **HKDF-SHA256** (RFC 5869 extract-and-expand). Cryptographically separates master secrets into dedicated AEAD and authentication keys.
   - **AEAD Cipher**: **ChaCha20-Poly1305** (RFC 8439). High performance in software without dedicated hardware AES-NI instructions, resistant to cache-timing attacks, 256-bit key, 96-bit nonce, 128-bit authentication tag.
   - **Hash Function**: **SHA-256** (FIPS 180-4) for message digests and end-to-end file integrity.

2. **Library Implementation Strategy (`CryptoProvider` Abstraction)**:
   - Define a pure TypeScript `CryptoProvider` interface in `@lumalink/core`.
   - Implement `NodeCryptoProvider` as the primary production provider using Node's standard `node:crypto`.
   - **Zero New Dependencies**: `node:crypto` is built into Node.js (powered by OpenSSL), fully audited, hardware-accelerated, and requires zero external npm packages.
   - Future platform integration (React Native quick-crypto, `@noble/*`, or WebCrypto) will implement the same `CryptoProvider` contract without modifying session, protocol, or transport layers.

## Alternatives Considered & Trade-offs

| Alternative                            | Evaluation                                                | Trade-offs & Decision                                                                                                                                                             |
| :------------------------------------- | :-------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`node:crypto` (Selected)**           | Standard Node.js crypto module using OpenSSL.             | **Pros**: Formally audited, zero npm dependencies, constant-time operations, native C++ performance.<br>**Cons**: Requires platform provider adapter for React Native in Phase 5. |
| **`@noble/curves` + `@noble/ciphers`** | Audited pure TypeScript libraries (Paul Miller / Cure53). | **Pros**: Cross-platform across all JS runtimes.<br>**Cons**: Introduces external npm dependencies; pure JS execution is slower than OpenSSL during heavy multi-block transfers.  |
| **`tweetnacl-js`**                     | Widely used Port of NaCl.                                 | **Pros**: Compact.<br>**Cons**: Lacks standard ChaCha20-Poly1305 (uses XSalsa20), lacks HKDF, legacy codebase with minimal active maintenance.                                    |
| **`libsodium-wrappers`**               | WebAssembly/C wrapper of Libsodium.                       | **Pros**: Gold standard cryptographic library.<br>**Cons**: Large binary size, asynchronous Wasm initialization complexity in headless and mobile runtimes.                       |
| **Custom Cryptography**                | Hand-rolled implementations.                              | **Strictly Rejected**: Custom cryptography violates core engineering principles and creates severe security vulnerabilities.                                                      |

## Consequences

- The core protocol remains 100% dependency-free.
- Cryptographic operations are benchmarked and verified against standard test vectors.
- Strict isolation: the security layer interacts only via the `CryptoProvider` interface.

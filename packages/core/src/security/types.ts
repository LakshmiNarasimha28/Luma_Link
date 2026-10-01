/**
 * Cryptographic security types and interfaces for LumaLink.
 */

export type SecurityMode = 'quick' | 'private';

export interface KeyPair {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

export interface DeviceIdentity {
  readonly deviceId: string;
  readonly keyPair: KeyPair;
  readonly displayName?: string;
}

export type MessageDirection = 'sender' | 'receiver';

export interface SessionKeys {
  readonly encryptionKey: Uint8Array;
  readonly nonceSalt: Uint8Array;
}

export interface EncryptedPayload {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly tag: Uint8Array;
}

export interface EncryptedKeyEnvelope {
  readonly targetDeviceId: string;
  readonly ephemeralPublicKey: Uint8Array;
  readonly wrappedSessionKey: EncryptedPayload;
}

export type ReceiverAuthState = 'pending' | 'authorized' | 'rejected' | 'revoked';

export interface AuthRequest {
  readonly sessionId: string;
  readonly receiverDeviceId: string;
  readonly receiverPublicKey: Uint8Array;
  readonly timestamp: number;
}

export interface AuthResponse {
  readonly sessionId: string;
  readonly receiverDeviceId: string;
  readonly state: ReceiverAuthState;
  readonly keyEnvelope?: EncryptedKeyEnvelope;
  readonly message?: string;
}

/**
 * Standard pluggable cryptographic provider interface.
 */
export interface CryptoProvider {
  /** Generates a fresh 32-byte X25519 keypair */
  generateKeyPair(): KeyPair;
  /** Computes a 32-byte shared secret via X25519 ECDH */
  computeSharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array;
  /** Derives key material via HKDF-SHA256 (RFC 5869) */
  hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array;
  /** Encrypts data using ChaCha20-Poly1305 AEAD */
  encryptAead(
    key: Uint8Array,
    nonce: Uint8Array,
    plaintext: Uint8Array,
    associatedData?: Uint8Array,
  ): EncryptedPayload;
  /** Decrypts and verifies data using ChaCha20-Poly1305 AEAD */
  decryptAead(
    key: Uint8Array,
    nonce: Uint8Array,
    payload: EncryptedPayload,
    associatedData?: Uint8Array,
  ): Uint8Array;
  /** Returns cryptographically secure random bytes */
  randomBytes(length: number): Uint8Array;
}

// ============================================================================
// Security Error Types
// ============================================================================

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

export class DecryptionError extends SecurityError {
  constructor(message: string = 'AEAD tag verification failed or ciphertext is corrupted') {
    super(message);
    this.name = 'DecryptionError';
  }
}

export class ReplayError extends SecurityError {
  readonly sequenceNumber: number;
  constructor(sequenceNumber: number) {
    super(`Packet rejected: replayed or duplicate sequence number ${sequenceNumber}`);
    this.name = 'ReplayError';
    this.sequenceNumber = sequenceNumber;
  }
}

export class UnauthorizedReceiverError extends SecurityError {
  readonly deviceId: string;
  constructor(deviceId: string) {
    super(`Receiver ${deviceId} is not authorized for this session`);
    this.name = 'UnauthorizedReceiverError';
    this.deviceId = deviceId;
  }
}

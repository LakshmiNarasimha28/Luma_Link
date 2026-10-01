/**
 * Security abstractions and boundaries for LumaLink.
 * Future phases will integrate X25519, HKDF, and AEAD (e.g. ChaCha20-Poly1305 / AES-GCM).
 */

export type SecurityMode = 'quick' | 'private';

export interface KeyPair {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

export interface SessionKeys {
  readonly encryptionKey: Uint8Array;
  readonly authKey: Uint8Array;
}

export interface EncryptedPayload {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly tag: Uint8Array;
}

export interface SecurityContext {
  readonly mode: SecurityMode;
  readonly sessionId: string;
  encrypt(plaintext: Uint8Array, associatedData?: Uint8Array): Promise<EncryptedPayload>;
  decrypt(payload: EncryptedPayload, associatedData?: Uint8Array): Promise<Uint8Array>;
}

import type {
  CryptoProvider,
  SecurityMode,
  AuthRequest,
  AuthResponse,
  EncryptedKeyEnvelope,
  ReceiverAuthState,
} from './types.js';
import { defaultCryptoProvider } from './crypto-provider.js';
import { sessionIdToBytes } from '../packet/binary-codec.js';

/**
 * Manages authorization policies and key distribution for Quick Send and Private Send.
 */
export class AuthorizationManager {
  readonly sessionId: string;
  readonly mode: SecurityMode;
  readonly senderEphemeralPrivateKey: Uint8Array;
  readonly senderEphemeralPublicKey: Uint8Array;
  readonly masterSharedSecret: Uint8Array;
  readonly crypto: CryptoProvider;

  private readonly receiverStates: Map<string, ReceiverAuthState> = new Map();
  private readonly receiverPublicKeys: Map<string, Uint8Array> = new Map();

  constructor(
    sessionId: string,
    mode: SecurityMode,
    senderEphemeralPrivateKey: Uint8Array,
    senderEphemeralPublicKey: Uint8Array,
    masterSharedSecret: Uint8Array,
    crypto: CryptoProvider = defaultCryptoProvider,
  ) {
    this.sessionId = sessionId;
    this.mode = mode;
    this.senderEphemeralPrivateKey = senderEphemeralPrivateKey;
    this.senderEphemeralPublicKey = senderEphemeralPublicKey;
    this.masterSharedSecret = masterSharedSecret;
    this.crypto = crypto;
  }

  /**
   * Generates an EncryptedKeyEnvelope wrapping the masterSharedSecret for a specific receiver
   * using pairwise X25519 ECDH + HKDF + ChaCha20-Poly1305.
   */
  createKeyEnvelope(receiverDeviceId: string, receiverPublicKey: Uint8Array): EncryptedKeyEnvelope {
    // 1. Key Encapsulation: compute pairwise ECDH secret
    const pairwiseSecret = this.crypto.computeSharedSecret(
      this.senderEphemeralPrivateKey,
      receiverPublicKey,
    );

    // 2. Derive wrapping key via HKDF bound to sessionId
    const salt = sessionIdToBytes(this.sessionId);
    const wrapKey = this.crypto.hkdf(
      pairwiseSecret,
      salt,
      new TextEncoder().encode('LumaLink-KeyWrap-v1'),
      32,
    );

    // 3. Encrypt master shared secret under wrapKey
    const wrapNonce = this.crypto.randomBytes(12);
    const aad = new TextEncoder().encode(`LumaLink-Envelope:${this.sessionId}:${receiverDeviceId}`);
    const wrappedSessionKey = this.crypto.encryptAead(
      wrapKey,
      wrapNonce,
      this.masterSharedSecret,
      aad,
    );

    return {
      targetDeviceId: receiverDeviceId,
      ephemeralPublicKey: this.senderEphemeralPublicKey,
      wrappedSessionKey,
    };
  }

  /**
   * Handles an incoming authorization request from a receiver.
   * In Quick Send, requests are automatically approved and immediately return
   * an encrypted key envelope containing the broadcast session key.
   * In Private Send, requests transition to 'pending' awaiting explicit sender approval.
   */
  handleAuthRequest(request: AuthRequest): AuthResponse {
    this.receiverPublicKeys.set(request.receiverDeviceId, request.receiverPublicKey);

    if (this.mode === 'quick') {
      this.receiverStates.set(request.receiverDeviceId, 'authorized');
      const keyEnvelope = this.createKeyEnvelope(
        request.receiverDeviceId,
        request.receiverPublicKey,
      );
      return {
        sessionId: this.sessionId,
        receiverDeviceId: request.receiverDeviceId,
        state: 'authorized',
        keyEnvelope,
      };
    }

    // Private Send: record as pending awaiting explicit approval
    this.receiverStates.set(request.receiverDeviceId, 'pending');
    return {
      sessionId: this.sessionId,
      receiverDeviceId: request.receiverDeviceId,
      state: 'pending',
      message: 'Awaiting sender approval',
    };
  }

  /**
   * Explicitly approves a receiver in Private Send mode and generates their wrapped key envelope.
   */
  approveReceiver(receiverDeviceId: string): AuthResponse {
    const receiverPubKey = this.receiverPublicKeys.get(receiverDeviceId);
    if (!receiverPubKey) {
      throw new Error(`Receiver ${receiverDeviceId} has not submitted a public key`);
    }

    this.receiverStates.set(receiverDeviceId, 'authorized');
    const keyEnvelope = this.createKeyEnvelope(receiverDeviceId, receiverPubKey);

    return {
      sessionId: this.sessionId,
      receiverDeviceId,
      state: 'authorized',
      keyEnvelope,
    };
  }

  /**
   * Explicitly denies access to a receiver in Private Send mode.
   */
  rejectReceiver(receiverDeviceId: string, reason?: string): AuthResponse {
    this.receiverStates.set(receiverDeviceId, 'rejected');
    return {
      sessionId: this.sessionId,
      receiverDeviceId,
      state: 'rejected',
      message: reason ?? 'Authorization denied by sender',
    };
  }

  getReceiverState(receiverDeviceId: string): ReceiverAuthState {
    return this.receiverStates.get(receiverDeviceId) ?? 'pending';
  }

  isAuthorized(receiverDeviceId: string): boolean {
    if (this.mode === 'quick') {
      return true;
    }
    return this.receiverStates.get(receiverDeviceId) === 'authorized';
  }

  /**
   * Client-side helper: Unwraps a received key envelope using the receiver's private key.
   */
  static unwrapKeyEnvelope(
    envelope: EncryptedKeyEnvelope,
    receiverPrivateKey: Uint8Array,
    sessionId: string,
    crypto: CryptoProvider = defaultCryptoProvider,
  ): Uint8Array {
    const pairwiseSecret = crypto.computeSharedSecret(
      receiverPrivateKey,
      envelope.ephemeralPublicKey,
    );

    const salt = sessionIdToBytes(sessionId);
    const wrapKey = crypto.hkdf(
      pairwiseSecret,
      salt,
      new TextEncoder().encode('LumaLink-KeyWrap-v1'),
      32,
    );

    const aad = new TextEncoder().encode(
      `LumaLink-Envelope:${sessionId}:${envelope.targetDeviceId}`,
    );

    return crypto.decryptAead(
      wrapKey,
      envelope.wrappedSessionKey.nonce,
      envelope.wrappedSessionKey,
      aad,
    );
  }
}

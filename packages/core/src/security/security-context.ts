import type {
  CryptoProvider,
  SecurityMode,
  SessionKeys,
  EncryptedPayload,
  MessageDirection,
} from './types.js';
import { DecryptionError } from './types.js';
import { NonceManager } from './nonce.js';
import { ReplayProtector } from './replay-protector.js';
import { defaultCryptoProvider } from './crypto-provider.js';
import { sessionIdToBytes } from '../packet/binary-codec.js';

export const AUTH_TAG_LENGTH_BYTES = 16;

/**
 * Builds the Associated Authenticated Data (AAD) binding packet metadata into the AEAD tag.
 *
 * AAD Layout (26 bytes):
 *   [0..15]  Session ID (16 bytes)
 *   [16..19] Block Index (uint32 BE)
 *   [20..23] Symbol ID (uint32 BE)
 *   [24]     Packet Type Code (uint8)
 *   [25]     Flags (uint8)
 */
export function buildPacketAad(
  sessionId: string,
  blockIndex: number,
  symbolId: number,
  packetTypeCode: number = 2, // Default to DATA
  flags: number = 0,
): Uint8Array {
  const aad = new Uint8Array(26);
  const sessionBytes = sessionIdToBytes(sessionId);
  aad.set(sessionBytes, 0);

  const view = new DataView(aad.buffer, aad.byteOffset, aad.byteLength);
  view.setUint32(16, blockIndex, false);
  view.setUint32(20, symbolId, false);
  view.setUint8(24, packetTypeCode);
  view.setUint8(25, flags);

  return aad;
}

/**
 * Derives a full set of session keys from a 32-byte shared secret and session ID.
 *
 * Output:
 * - 32-byte ChaCha20-Poly1305 encryption key
 * - 3-byte structured nonce salt prefix
 * (Independent MAC key removed as Poly1305 AEAD handles authentication internally).
 */
export function deriveSessionKeys(
  sharedSecret: Uint8Array,
  sessionId: string,
  mode: SecurityMode,
  crypto: CryptoProvider = defaultCryptoProvider,
): SessionKeys {
  const salt = sessionIdToBytes(sessionId);
  const infoPrefix = mode === 'quick' ? 'LumaLink-QuickSend-v2' : 'LumaLink-PrivateSend-v2';

  // 1. Encryption Key (32 bytes)
  const encryptionKey = crypto.hkdf(
    sharedSecret,
    salt,
    new TextEncoder().encode(`${infoPrefix}-AEAD-Key`),
    32,
  );

  // 2. Nonce Salt Prefix (3 bytes for 12-byte structured nonce: 1B tag + 3B salt + 4B block + 4B symbol)
  const nonceSalt = crypto.hkdf(
    sharedSecret,
    salt,
    new TextEncoder().encode(`${infoPrefix}-Nonce-Salt`),
    3,
  );

  return { encryptionKey, nonceSalt };
}

/**
 * Manages AEAD encryption, decryption, nonce generation, and replay protection
 * for an active LumaLink session.
 */
export class SessionSecurityContext {
  readonly sessionId: string;
  readonly mode: SecurityMode;
  readonly keys: SessionKeys;
  readonly crypto: CryptoProvider;
  readonly nonceManager: NonceManager;
  readonly replayProtector: ReplayProtector;

  constructor(
    sessionId: string,
    mode: SecurityMode,
    keys: SessionKeys,
    crypto: CryptoProvider = defaultCryptoProvider,
  ) {
    this.sessionId = sessionId;
    this.mode = mode;
    this.keys = keys;
    this.crypto = crypto;
    this.nonceManager = new NonceManager(keys.nonceSalt);
    this.replayProtector = new ReplayProtector();
  }

  /**
   * Encrypts a symbol payload using ChaCha20-Poly1305 with AAD binding.
   */
  encryptPayload(
    blockIndex: number,
    symbolId: number,
    plaintext: Uint8Array,
    packetTypeCode: number = 2,
    flags: number = 0,
    direction: MessageDirection = 'sender',
  ): EncryptedPayload {
    const nonce = this.nonceManager.generateNonce(blockIndex, symbolId, packetTypeCode, direction);
    const aad = buildPacketAad(this.sessionId, blockIndex, symbolId, packetTypeCode, flags);

    return this.crypto.encryptAead(this.keys.encryptionKey, nonce, plaintext, aad);
  }

  /**
   * Encrypts plaintext and packs the 16-byte Poly1305 tag + ciphertext into a single buffer
   * suitable for transport packet payload.
   */
  encryptToWirePayload(
    blockIndex: number,
    symbolId: number,
    plaintext: Uint8Array,
    packetTypeCode: number = 2,
    flags: number = 0,
    direction: MessageDirection = 'sender',
  ): Uint8Array {
    const enc = this.encryptPayload(
      blockIndex,
      symbolId,
      plaintext,
      packetTypeCode,
      flags,
      direction,
    );
    const wire = new Uint8Array(AUTH_TAG_LENGTH_BYTES + enc.ciphertext.length);
    wire.set(enc.tag, 0);
    wire.set(enc.ciphertext, AUTH_TAG_LENGTH_BYTES);
    return wire;
  }

  /**
   * Decrypts and authenticates an incoming packet payload.
   * Performs replay check and verifies AAD cryptographic binding.
   */
  decryptPayload(
    blockIndex: number,
    symbolId: number,
    payload: EncryptedPayload,
    packetTypeCode: number = 2,
    flags: number = 0,
    checkReplay: boolean = true,
    direction: MessageDirection = 'sender',
  ): Uint8Array {
    if (checkReplay) {
      this.replayProtector.checkAndRecord(blockIndex, symbolId, true, packetTypeCode, direction);
    }

    const nonce =
      payload.nonce.length === 12
        ? payload.nonce
        : NonceManager.buildNonce(
            this.keys.nonceSalt,
            blockIndex,
            symbolId,
            packetTypeCode,
            direction,
          );

    const aad = buildPacketAad(this.sessionId, blockIndex, symbolId, packetTypeCode, flags);

    return this.crypto.decryptAead(this.keys.encryptionKey, nonce, payload, aad);
  }

  /**
   * Unpacks [Tag (16B) | Ciphertext (NB)] from a transport packet payload and decrypts it.
   */
  decryptFromWirePayload(
    blockIndex: number,
    symbolId: number,
    wirePayload: Uint8Array,
    packetTypeCode: number = 2,
    flags: number = 0,
    checkReplay: boolean = true,
    direction: MessageDirection = 'sender',
  ): Uint8Array {
    if (wirePayload.length < AUTH_TAG_LENGTH_BYTES) {
      throw new DecryptionError('Wire payload is shorter than AEAD tag length');
    }

    const tag = wirePayload.subarray(0, AUTH_TAG_LENGTH_BYTES);
    const ciphertext = wirePayload.subarray(AUTH_TAG_LENGTH_BYTES);
    const nonce = NonceManager.buildNonce(
      this.keys.nonceSalt,
      blockIndex,
      symbolId,
      packetTypeCode,
      direction,
    );

    return this.decryptPayload(
      blockIndex,
      symbolId,
      { ciphertext, tag, nonce },
      packetTypeCode,
      flags,
      checkReplay,
      direction,
    );
  }
}

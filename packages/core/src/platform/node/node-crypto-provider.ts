import crypto from 'node:crypto';
import type { CryptoProvider, KeyPair, EncryptedPayload } from '../../security/types.js';
import { DecryptionError } from '../../security/types.js';

// ASN.1 DER Prefixes for raw 32-byte Curve25519 keys
// SPKI prefix: 12 bytes [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00]
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
// PKCS#8 prefix: 16 bytes [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

/**
 * Standard production cryptographic provider utilizing Node.js native crypto (OpenSSL).
 * Implements X25519, HKDF-SHA256, and ChaCha20-Poly1305 with zero external dependencies.
 */
export class NodeCryptoProvider implements CryptoProvider {
  generateKeyPair(): KeyPair {
    const kp = crypto.generateKeyPairSync('x25519');
    const spkiDer = kp.publicKey.export({ type: 'spki', format: 'der' });
    const pkcs8Der = kp.privateKey.export({ type: 'pkcs8', format: 'der' });

    // The raw 32-byte key is at the end of each standard DER structure
    const rawPublicKey = new Uint8Array(spkiDer.subarray(spkiDer.length - 32));
    const rawPrivateKey = new Uint8Array(pkcs8Der.subarray(pkcs8Der.length - 32));

    return {
      publicKey: rawPublicKey,
      privateKey: rawPrivateKey,
    };
  }

  computeSharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
    if (privateKey.length !== 32) {
      throw new RangeError(`X25519 private key must be 32 bytes, got ${privateKey.length}`);
    }
    if (publicKey.length !== 32) {
      throw new RangeError(`X25519 public key must be 32 bytes, got ${publicKey.length}`);
    }

    const privDer = Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(privateKey)]);
    const pubDer = Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(publicKey)]);

    const privObj = crypto.createPrivateKey({
      key: privDer,
      format: 'der',
      type: 'pkcs8',
    });
    const pubObj = crypto.createPublicKey({
      key: pubDer,
      format: 'der',
      type: 'spki',
    });

    const secret = crypto.diffieHellman({
      privateKey: privObj,
      publicKey: pubObj,
    });
    return new Uint8Array(secret);
  }

  hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array {
    const derived = crypto.hkdfSync(
      'sha256',
      Buffer.from(ikm),
      Buffer.from(salt),
      Buffer.from(info),
      length,
    );
    return new Uint8Array(derived);
  }

  encryptAead(
    key: Uint8Array,
    nonce: Uint8Array,
    plaintext: Uint8Array,
    associatedData?: Uint8Array,
  ): EncryptedPayload {
    if (key.length !== 32) {
      throw new RangeError(`ChaCha20 key must be 32 bytes, got ${key.length}`);
    }
    if (nonce.length !== 12) {
      throw new RangeError(`ChaCha20-Poly1305 nonce must be 12 bytes, got ${nonce.length}`);
    }

    const cipher = crypto.createCipheriv(
      'chacha20-poly1305',
      Buffer.from(key),
      Buffer.from(nonce),
      { authTagLength: 16 },
    );

    if (associatedData && associatedData.length > 0) {
      cipher.setAAD(Buffer.from(associatedData), {
        plaintextLength: plaintext.length,
      });
    }

    const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      ciphertext: new Uint8Array(ciphertext),
      nonce: new Uint8Array(nonce),
      tag: new Uint8Array(tag),
    };
  }

  decryptAead(
    key: Uint8Array,
    nonce: Uint8Array,
    payload: EncryptedPayload,
    associatedData?: Uint8Array,
  ): Uint8Array {
    if (key.length !== 32) {
      throw new RangeError(`ChaCha20 key must be 32 bytes, got ${key.length}`);
    }
    if (nonce.length !== 12) {
      throw new RangeError(`ChaCha20-Poly1305 nonce must be 12 bytes, got ${nonce.length}`);
    }
    if (payload.tag.length !== 16) {
      throw new DecryptionError('Invalid authentication tag length (must be 16 bytes)');
    }

    try {
      const decipher = crypto.createDecipheriv(
        'chacha20-poly1305',
        Buffer.from(key),
        Buffer.from(nonce),
        { authTagLength: 16 },
      );

      if (associatedData && associatedData.length > 0) {
        decipher.setAAD(Buffer.from(associatedData), {
          plaintextLength: payload.ciphertext.length,
        });
      }

      decipher.setAuthTag(Buffer.from(payload.tag));

      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(payload.ciphertext)),
        decipher.final(),
      ]);

      return new Uint8Array(plaintext);
    } catch {
      throw new DecryptionError(
        'AEAD tag verification failed: ciphertext is corrupted, tampered, or key/nonce/AAD mismatch',
      );
    }
  }

  randomBytes(length: number): Uint8Array {
    return new Uint8Array(crypto.randomBytes(length));
  }
}

/** Default singleton instance for Node environments */
export const defaultNodeCryptoProvider: CryptoProvider = new NodeCryptoProvider();

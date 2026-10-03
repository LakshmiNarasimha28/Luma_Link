import { describe, it, expect } from 'vitest';
import { NodeCryptoProvider } from '../src/platform/node/index.js';
import { DecryptionError } from '../src/security/types.js';

describe('Cryptographic Primitives (X25519, HKDF, ChaCha20-Poly1305)', () => {
  const crypto = new NodeCryptoProvider();

  describe('X25519 Key Agreement', () => {
    it('computes identical 32-byte shared secrets for Alice and Bob', () => {
      const alice = crypto.generateKeyPair();
      const bob = crypto.generateKeyPair();

      expect(alice.publicKey.length).toBe(32);
      expect(alice.privateKey.length).toBe(32);
      expect(bob.publicKey.length).toBe(32);
      expect(bob.privateKey.length).toBe(32);

      const secretAlice = crypto.computeSharedSecret(alice.privateKey, bob.publicKey);
      const secretBob = crypto.computeSharedSecret(bob.privateKey, alice.publicKey);

      expect(secretAlice.length).toBe(32);
      expect(secretBob.length).toBe(32);
      expect(secretAlice).toEqual(secretBob);
    });

    it('produces completely different shared secrets when an incorrect key is used', () => {
      const alice = crypto.generateKeyPair();
      const bob = crypto.generateKeyPair();
      const eve = crypto.generateKeyPair();

      const secretAliceBob = crypto.computeSharedSecret(alice.privateKey, bob.publicKey);
      const secretEveBob = crypto.computeSharedSecret(eve.privateKey, bob.publicKey);

      expect(secretAliceBob).not.toEqual(secretEveBob);
    });

    it('rejects invalid key lengths for scalar multiplication', () => {
      const validKey = crypto.generateKeyPair().publicKey;
      const invalidKey = new Uint8Array(16); // Only 16 bytes

      expect(() => crypto.computeSharedSecret(invalidKey, validKey)).toThrow(RangeError);
      expect(() => crypto.computeSharedSecret(validKey, invalidKey)).toThrow(RangeError);
    });
  });

  describe('HKDF Key Derivation (RFC 5869)', () => {
    it('is deterministic and generates requested byte lengths', () => {
      const ikm = crypto.randomBytes(32);
      const salt = crypto.randomBytes(16);
      const info = new TextEncoder().encode('LumaLink-Test-Key');

      const key1 = crypto.hkdf(ikm, salt, info, 32);
      const key2 = crypto.hkdf(ikm, salt, info, 32);

      expect(key1.length).toBe(32);
      expect(key1).toEqual(key2);
    });

    it('yields cryptographically distinct keys under different info contexts', () => {
      const ikm = crypto.randomBytes(32);
      const salt = crypto.randomBytes(16);

      const encKey = crypto.hkdf(ikm, salt, new TextEncoder().encode('LumaLink-AEAD-Key'), 32);
      const authKey = crypto.hkdf(ikm, salt, new TextEncoder().encode('LumaLink-Auth-Key'), 32);

      expect(encKey).not.toEqual(authKey);
    });
  });

  describe('ChaCha20-Poly1305 AEAD', () => {
    const key = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const plaintext = new TextEncoder().encode('LumaLink Secure Optical Payload');
    const aad = new TextEncoder().encode('session:00112233:block:0:sym:1');

    it('performs clean authenticated encryption and decryption round-trip', () => {
      const encrypted = crypto.encryptAead(key, nonce, plaintext, aad);

      expect(encrypted.ciphertext.length).toBe(plaintext.length);
      expect(encrypted.tag.length).toBe(16);
      expect(encrypted.nonce).toEqual(nonce);

      const decrypted = crypto.decryptAead(key, nonce, encrypted, aad);
      expect(decrypted).toEqual(plaintext);
    });

    it('rejects tampered ciphertext with DecryptionError', () => {
      const encrypted = crypto.encryptAead(key, nonce, plaintext, aad);

      // Tamper 1 bit in ciphertext
      const tamperedCiphertext = new Uint8Array(encrypted.ciphertext);
      tamperedCiphertext[0]! ^= 0x01;

      const tamperedPayload = {
        ciphertext: tamperedCiphertext,
        nonce: encrypted.nonce,
        tag: encrypted.tag,
      };

      expect(() => crypto.decryptAead(key, nonce, tamperedPayload, aad)).toThrow(DecryptionError);
    });

    it('rejects tampered authentication tag with DecryptionError', () => {
      const encrypted = crypto.encryptAead(key, nonce, plaintext, aad);

      // Tamper 1 bit in tag
      const tamperedTag = new Uint8Array(encrypted.tag);
      tamperedTag[15]! ^= 0x01;

      const tamperedPayload = {
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        tag: tamperedTag,
      };

      expect(() => crypto.decryptAead(key, nonce, tamperedPayload, aad)).toThrow(DecryptionError);
    });

    it('rejects tampered Associated Authenticated Data (AAD) with DecryptionError', () => {
      const encrypted = crypto.encryptAead(key, nonce, plaintext, aad);

      const modifiedAad = new TextEncoder().encode('session:00112233:block:0:sym:2'); // Swapped symbolId!

      expect(() => crypto.decryptAead(key, nonce, encrypted, modifiedAad)).toThrow(DecryptionError);
    });

    it('rejects decryption under the wrong key', () => {
      const encrypted = crypto.encryptAead(key, nonce, plaintext, aad);
      const wrongKey = crypto.randomBytes(32);

      expect(() => crypto.decryptAead(wrongKey, nonce, encrypted, aad)).toThrow(DecryptionError);
    });

    it('rejects decryption under the wrong nonce', () => {
      const encrypted = crypto.encryptAead(key, nonce, plaintext, aad);
      const wrongNonce = new Uint8Array(nonce);
      wrongNonce[0]! ^= 0xff;

      expect(() => crypto.decryptAead(key, wrongNonce, encrypted, aad)).toThrow(DecryptionError);
    });
  });
});

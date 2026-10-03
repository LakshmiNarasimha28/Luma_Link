import type { CryptoProvider } from './types.js';
import { SecurityError } from './types.js';

let currentDefaultCryptoProvider: CryptoProvider | null = null;

/**
 * Registers the active default CryptoProvider for the runtime environment.
 */
export function setDefaultCryptoProvider(provider: CryptoProvider): void {
  currentDefaultCryptoProvider = provider;
}

/**
 * Returns the currently registered default CryptoProvider.
 * Throws SecurityError if no provider has been registered.
 */
export function getDefaultCryptoProvider(): CryptoProvider {
  if (!currentDefaultCryptoProvider) {
    throw new SecurityError(
      'No CryptoProvider has been configured. In Node.js environments, import "@lumalink/core/node". In browser or mobile environments, provide a platform-specific CryptoProvider.',
    );
  }
  return currentDefaultCryptoProvider;
}

/**
 * Delegating accessor for default cryptographic operations.
 */
export const defaultCryptoProvider: CryptoProvider = {
  generateKeyPair() {
    return getDefaultCryptoProvider().generateKeyPair();
  },
  computeSharedSecret(privateKey, publicKey) {
    return getDefaultCryptoProvider().computeSharedSecret(privateKey, publicKey);
  },
  hkdf(ikm, salt, info, length) {
    return getDefaultCryptoProvider().hkdf(ikm, salt, info, length);
  },
  encryptAead(key, nonce, plaintext, associatedData) {
    return getDefaultCryptoProvider().encryptAead(key, nonce, plaintext, associatedData);
  },
  decryptAead(key, nonce, payload, associatedData) {
    return getDefaultCryptoProvider().decryptAead(key, nonce, payload, associatedData);
  },
  randomBytes(length) {
    return getDefaultCryptoProvider().randomBytes(length);
  },
};

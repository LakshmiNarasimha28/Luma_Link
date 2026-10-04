package com.lumalink.harness.crypto

import java.security.KeyFactory
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Standard Android cryptographic provider leveraging native JCA / AndroidOpenSSL.
 *
 * Implements:
 * - X25519 key agreement via standard ASN.1 DER wrapping (zero external crypto dependencies)
 * - HMAC-SHA256
 * - RFC 5869 HKDF (Extract and Expand)
 * - ChaCha20-Poly1305 AEAD with automatic wire format conversion:
 *     Wire: [TAG (16B) || CIPHERTEXT (NB)] <-> JCA: [CIPHERTEXT (NB) || TAG (16B)]
 */
class AndroidCryptoProvider {

    companion object {
        const val AUTH_TAG_LENGTH_BYTES = 16
        const val X25519_KEY_LENGTH_BYTES = 32
        const val CHACHA20_KEY_LENGTH_BYTES = 32
        const val NONCE_LENGTH_BYTES = 12

        // Standard ASN.1 DER prefixes for Curve25519 raw 32-byte keys
        // PKCS#8 prefix: 16 bytes [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]
        private val X25519_PKCS8_PREFIX = byteArrayOf(
            0x30.toByte(), 0x2e.toByte(), 0x02.toByte(), 0x01.toByte(),
            0x00.toByte(), 0x30.toByte(), 0x05.toByte(), 0x06.toByte(),
            0x03.toByte(), 0x2b.toByte(), 0x65.toByte(), 0x6e.toByte(),
            0x04.toByte(), 0x22.toByte(), 0x04.toByte(), 0x20.toByte()
        )

        // SPKI prefix: 12 bytes [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00]
        private val X25519_SPKI_PREFIX = byteArrayOf(
            0x30.toByte(), 0x2a.toByte(), 0x30.toByte(), 0x05.toByte(),
            0x06.toByte(), 0x03.toByte(), 0x2b.toByte(), 0x65.toByte(),
            0x6e.toByte(), 0x03.toByte(), 0x21.toByte(), 0x00.toByte()
        )

        private fun getCipherInstance(): Cipher {
            return try {
                Cipher.getInstance("ChaCha20-Poly1305")
            } catch (_: Throwable) {
                Cipher.getInstance("ChaCha20/Poly1305/NoPadding")
            }
        }

        private fun getKeyFactoryInstance(): KeyFactory {
            return try {
                KeyFactory.getInstance("X25519")
            } catch (_: Throwable) {
                KeyFactory.getInstance("XDH")
            }
        }

        private fun getKeyAgreementInstance(): KeyAgreement {
            return try {
                KeyAgreement.getInstance("X25519")
            } catch (_: Throwable) {
                KeyAgreement.getInstance("XDH")
            }
        }
    }

    /**
     * Computes the 32-byte X25519 shared secret between a private key and a peer public key.
     */
    fun computeSharedSecret(privateKey: ByteArray, peerPublicKey: ByteArray): ByteArray {
        require(privateKey.size == X25519_KEY_LENGTH_BYTES) {
            "X25519 private key must be $X25519_KEY_LENGTH_BYTES bytes, got ${privateKey.size}"
        }
        require(peerPublicKey.size == X25519_KEY_LENGTH_BYTES) {
            "X25519 public key must be $X25519_KEY_LENGTH_BYTES bytes, got ${peerPublicKey.size}"
        }

        val kf = getKeyFactoryInstance()
        val ka = getKeyAgreementInstance()

        val privPkcs8 = ByteArray(X25519_PKCS8_PREFIX.size + privateKey.size)
        System.arraycopy(X25519_PKCS8_PREFIX, 0, privPkcs8, 0, X25519_PKCS8_PREFIX.size)
        System.arraycopy(privateKey, 0, privPkcs8, X25519_PKCS8_PREFIX.size, privateKey.size)
        val privKeyObj = kf.generatePrivate(PKCS8EncodedKeySpec(privPkcs8))

        val pubSpki = ByteArray(X25519_SPKI_PREFIX.size + peerPublicKey.size)
        System.arraycopy(X25519_SPKI_PREFIX, 0, pubSpki, 0, X25519_SPKI_PREFIX.size)
        System.arraycopy(peerPublicKey, 0, pubSpki, X25519_SPKI_PREFIX.size, peerPublicKey.size)
        val pubKeyObj = kf.generatePublic(X509EncodedKeySpec(pubSpki))

        ka.init(privKeyObj)
        ka.doPhase(pubKeyObj, true)
        return ka.generateSecret()
    }

    /**
     * Computes HMAC-SHA256 over data using the provided key.
     */
    fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        val effectiveKey = if (key.isNotEmpty()) key else ByteArray(32)
        mac.init(SecretKeySpec(effectiveKey, "HmacSHA256"))
        return mac.doFinal(data)
    }

    /**
     * RFC 5869 HMAC-based Extract-and-Expand Key Derivation Function (HKDF).
     */
    fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        // Step 1: Extract PRK = HMAC-Hash(salt, IKM)
        val prk = hmacSha256(salt, ikm)

        // Step 2: Expand OKM = HMAC-Hash(PRK, T(1) || info || 0x01) ...
        var t = ByteArray(0)
        var okm = ByteArray(0)
        var i = 1
        while (okm.size < length) {
            val input = ByteArray(t.size + info.size + 1)
            System.arraycopy(t, 0, input, 0, t.size)
            System.arraycopy(info, 0, input, t.size, info.size)
            input[input.size - 1] = i.toByte()

            t = hmacSha256(prk, input)

            val newOkm = ByteArray(okm.size + t.size)
            System.arraycopy(okm, 0, newOkm, 0, okm.size)
            System.arraycopy(t, 0, newOkm, okm.size, t.size)
            okm = newOkm
            i++
        }
        return okm.copyOf(length)
    }

    /**
     * Derives active session keys from a 32-byte shared secret and session ID.
     */
    fun deriveSessionKeys(
        sharedSecret: ByteArray,
        sessionIdBytes: ByteArray,
        infoPrefix: String = "LumaLink-QuickSend-v2"
    ): SessionKeys {
        val encKey = hkdf(
            ikm = sharedSecret,
            salt = sessionIdBytes,
            info = "$infoPrefix-AEAD-Key".toByteArray(Charsets.UTF_8),
            length = 32
        )
        val nonceSalt = hkdf(
            ikm = sharedSecret,
            salt = sessionIdBytes,
            info = "$infoPrefix-Nonce-Salt".toByteArray(Charsets.UTF_8),
            length = 3
        )
        return SessionKeys(encKey, nonceSalt)
    }

    /**
     * Encrypts plaintext using ChaCha20-Poly1305 with AAD binding.
     * Returns LumaLink Wire format: [TAG (16B) || CIPHERTEXT (NB)].
     */
    fun encryptAead(
        key: ByteArray,
        nonce: ByteArray,
        plaintext: ByteArray,
        aad: ByteArray
    ): ByteArray {
        require(key.size == CHACHA20_KEY_LENGTH_BYTES) { "Key must be 32 bytes" }
        require(nonce.size == NONCE_LENGTH_BYTES) { "Nonce must be 12 bytes" }

        val cipher = getCipherInstance()
        val keySpec = SecretKeySpec(key, "ChaCha20")
        val ivSpec = IvParameterSpec(nonce)

        cipher.init(Cipher.ENCRYPT_MODE, keySpec, ivSpec)
        cipher.updateAAD(aad)

        // JCA produces [CIPHERTEXT (NB) || TAG (16B)]
        val jcaEncrypted = cipher.doFinal(plaintext)
        val ciphertextLen = jcaEncrypted.size - AUTH_TAG_LENGTH_BYTES
        require(ciphertextLen >= 0) { "JCA AEAD output shorter than tag length" }

        // Adapt to LumaLink Wire format: [TAG (16B) || CIPHERTEXT (NB)]
        val wirePayload = ByteArray(jcaEncrypted.size)
        // Tag is at end of JCA buffer -> place at start of wire payload
        System.arraycopy(jcaEncrypted, ciphertextLen, wirePayload, 0, AUTH_TAG_LENGTH_BYTES)
        // Ciphertext is at start of JCA buffer -> place after tag
        System.arraycopy(jcaEncrypted, 0, wirePayload, AUTH_TAG_LENGTH_BYTES, ciphertextLen)

        return wirePayload
    }

    /**
     * Decrypts ciphertext and verifies the 16-byte Poly1305 tag under ChaCha20-Poly1305 with AAD.
     * Adapts LumaLink Wire format [TAG || CIPHERTEXT] to JCA [CIPHERTEXT || TAG] before Cipher.doFinal().
     *
     * @throws DecryptionException if tag verification fails or data is corrupt.
     */
    fun decryptAead(
        key: ByteArray,
        nonce: ByteArray,
        ciphertext: ByteArray,
        tag: ByteArray,
        aad: ByteArray
    ): ByteArray {
        require(key.size == CHACHA20_KEY_LENGTH_BYTES) { "Key must be 32 bytes" }
        require(nonce.size == NONCE_LENGTH_BYTES) { "Nonce must be 12 bytes" }
        require(tag.size == AUTH_TAG_LENGTH_BYTES) { "Tag must be 16 bytes" }

        // Assemble JCA payload: [CIPHERTEXT (NB) || TAG (16B)]
        val jcaBuffer = ByteArray(ciphertext.size + tag.size)
        System.arraycopy(ciphertext, 0, jcaBuffer, 0, ciphertext.size)
        System.arraycopy(tag, 0, jcaBuffer, ciphertext.size, tag.size)

        return try {
            val cipher = getCipherInstance()
            val keySpec = SecretKeySpec(key, "ChaCha20")
            val ivSpec = IvParameterSpec(nonce)

            cipher.init(Cipher.DECRYPT_MODE, keySpec, ivSpec)
            cipher.updateAAD(aad)
            cipher.doFinal(jcaBuffer)
        } catch (e: AEADBadTagException) {
            throw DecryptionException("AEAD tag verification failed: ciphertext is corrupted, tampered, or key/nonce/AAD mismatch", e)
        } catch (e: Exception) {
            throw DecryptionException("AEAD decryption failed: ${e.javaClass.simpleName}: ${e.message}", e)
        }
    }
}

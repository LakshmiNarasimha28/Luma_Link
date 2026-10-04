package com.lumalink.harness.crypto

/**
 * Encapsulates the derived active AEAD session keys:
 * - 32-byte ChaCha20-Poly1305 encryption key
 * - 3-byte structured nonce salt prefix
 *
 * Implements strict size validation and safe string representation to prevent
 * accidental logging or leakage of cryptographic secrets.
 */
class SessionKeys(
    val encryptionKey: ByteArray,
    val nonceSalt: ByteArray
) {
    companion object {
        const val ENCRYPTION_KEY_LENGTH = 32
        const val NONCE_SALT_LENGTH = 3
    }

    init {
        require(encryptionKey.size == ENCRYPTION_KEY_LENGTH) {
            "Encryption key must be exactly $ENCRYPTION_KEY_LENGTH bytes, got ${encryptionKey.size}"
        }
        require(nonceSalt.size == NONCE_SALT_LENGTH) {
            "Nonce salt must be exactly $NONCE_SALT_LENGTH bytes, got ${nonceSalt.size}"
        }
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false

        other as SessionKeys

        if (!encryptionKey.contentEquals(other.encryptionKey)) return false
        if (!nonceSalt.contentEquals(other.nonceSalt)) return false

        return true
    }

    override fun hashCode(): Int {
        var result = encryptionKey.contentHashCode()
        result = 31 * result + nonceSalt.contentHashCode()
        return result
    }

    override fun toString(): String {
        return "SessionKeys(encryptionKey=[${encryptionKey.size} bytes REDACTED], nonceSalt=[${nonceSalt.size} bytes REDACTED])"
    }
}

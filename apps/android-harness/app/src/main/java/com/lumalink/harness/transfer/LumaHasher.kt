package com.lumalink.harness.transfer

import java.security.MessageDigest

/**
 * Hasher abstraction for SHA-256 file integrity verification.
 * Exact parity with packages/core/src/transfer/hasher.ts [Hasher].
 */
interface LumaHasher {
    /**
     * Computes the hexadecimal SHA-256 digest (64 lowercase characters) for the given byte buffer.
     */
    fun hashSha256(data: ByteArray): String
}

/**
 * Standard Android/JVM SHA-256 Hasher using platform MessageDigest.
 * Backed by AndroidOpenSSL / Conscrypt on Android and standard JCA on JVM.
 * Guaranteed to produce bit-for-bit identical output to FIPS 180-4 and OpenSSL/Node crypto.
 */
class PlatformHasher : LumaHasher {
    override fun hashSha256(data: ByteArray): String {
        val md = MessageDigest.getInstance("SHA-256")
        val digest = md.digest(data)
        val sb = StringBuilder(64)
        for (b in digest) {
            val v = b.toInt() and 0xFF
            if (v < 16) sb.append('0')
            sb.append(Integer.toHexString(v))
        }
        return sb.toString()
    }
}

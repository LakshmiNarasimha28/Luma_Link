package com.lumalink.harness.crypto

/**
 * Base class for all LumaLink cryptographic and security-related exceptions.
 */
open class SecurityException(
    message: String,
    cause: Throwable? = null
) : Exception(message, cause)

/**
 * Thrown when AEAD ChaCha20-Poly1305 decryption or tag verification fails.
 * Indicates corrupted ciphertext, tampered payload, or key/nonce/AAD mismatch.
 */
class DecryptionException(
    message: String = "Decryption or AEAD authentication failed",
    cause: Throwable? = null
) : SecurityException(message, cause)

/**
 * Thrown when an incoming message fails replay protection checks.
 * Indicates that the sequence (direction:packetType:blockIndex:symbolId) was already observed.
 */
class ReplayException(
    val symbolId: Long,
    message: String = "Replay detected for symbol $symbolId"
) : SecurityException(message)

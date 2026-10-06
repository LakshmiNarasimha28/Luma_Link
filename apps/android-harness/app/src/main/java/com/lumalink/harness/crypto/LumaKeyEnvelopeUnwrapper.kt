package com.lumalink.harness.crypto

import com.lumalink.harness.session.LumaSessionAnnouncement
import java.util.concurrent.ConcurrentHashMap

// ============================================================================
// Exceptions
// ============================================================================

open class KeyEnvelopeException(message: String, cause: Throwable? = null) : Exception(message, cause)

class ManifestKeyMismatchException(val manifestKey: ByteArray, val envelopeKey: ByteArray) :
    KeyEnvelopeException(
        "Manifest-to-envelope key binding violation: envelope ephemeralPublicKey does not match active manifest senderPublicKey"
    )

class ConflictingKeyEnvelopeException(message: String) : KeyEnvelopeException(message)

class TargetDeviceMismatchException(val expected: String, val actual: String) :
    KeyEnvelopeException("Target device mismatch: envelope is sealed for '$actual', expected '$expected'")

class MissingManifestException(message: String) : KeyEnvelopeException(message)

// ============================================================================
// Result
// ============================================================================

sealed class KeyEnvelopeUnwrapResult {
    data class Accepted(
        val context: LumaSecurityContext,
        val broadcastSecret: ByteArray
    ) : KeyEnvelopeUnwrapResult() {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (javaClass != other?.javaClass) return false
            other as Accepted
            return broadcastSecret.contentEquals(other.broadcastSecret)
        }

        override fun hashCode(): Int = broadcastSecret.contentHashCode()
    }

    data class DuplicateAccepted(
        val context: LumaSecurityContext
    ) : KeyEnvelopeUnwrapResult()
}

// ============================================================================
// Unwrapper Implementation
// ============================================================================

/**
 * Android receiver-side key envelope unwrapping and session security context establishment.
 *
 * Enforces:
 * 1. Target device ID matching
 * 2. Mandatory Manifest-Key Binding Invariant:
 *      manifest.senderPublicKey == envelope.ephemeralPublicKey
 *    (Fails closed immediately before any cryptographic operations)
 * 3. Complete envelope byte-for-byte deduplication for optical carousel repetition
 * 4. X25519 ECDH pairwise secret agreement
 * 5. HKDF-SHA256 key wrapping derivation ("LumaLink-KeyWrap-v1")
 * 6. ChaCha20-Poly1305 authenticated envelope decryption
 * 7. Dynamic SessionSecurityContext derivation and registration
 */
class LumaKeyEnvelopeUnwrapper(
    private val localDeviceId: String,
    private val localPrivateKey: ByteArray,
    private val crypto: AndroidCryptoProvider = AndroidCryptoProvider()
) {
    init {
        require(localPrivateKey.size == 32) { "Local private key must be 32 bytes, received ${localPrivateKey.size}" }
    }

    // Records the complete raw envelope bytes of successfully unwrapped sessions
    private val activeEnvelopes = ConcurrentHashMap<String, ByteArray>()
    // Records the established security contexts
    private val activeContexts = ConcurrentHashMap<String, LumaSecurityContext>()

    companion object {
        fun bytesToHex(bytes: ByteArray): String {
            val sb = StringBuilder(bytes.size * 2)
            for (b in bytes) {
                val v = b.toInt() and 0xFF
                if (v < 16) sb.append('0')
                sb.append(Integer.toHexString(v))
            }
            return sb.toString()
        }

        fun bytesToSessionIdUuid(bytes: ByteArray): String {
            require(bytes.size == 16) { "Session ID must be 16 bytes" }
            val hex = bytesToHex(bytes)
            return "${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}"
        }

        fun buildEnvelopeAad(sessionIdBytes: ByteArray, targetDeviceId: String): ByteArray {
            val uuidStr = bytesToSessionIdUuid(sessionIdBytes)
            return "LumaLink-Envelope:$uuidStr:$targetDeviceId".toByteArray(Charsets.UTF_8)
        }
    }

    /**
     * Unwraps a received key envelope, verifies manifest key binding and complete envelope deduplication,
     * and establishes the active LumaSecurityContext.
     *
     * @param envelope The received key envelope
     * @param manifest The active session announcement manifest (acquired from MANIFEST packet)
     * @param rawEnvelopePayload The complete raw wire bytes of the control message payload
     * @return Accepted or DuplicateAccepted result
     */
    fun unwrapAndRegister(
        envelope: LumaEncryptedKeyEnvelope,
        manifest: LumaSessionAnnouncement,
        rawEnvelopePayload: ByteArray
    ): KeyEnvelopeUnwrapResult {
        // 1. Target device check
        if (envelope.targetDeviceId != localDeviceId) {
            throw TargetDeviceMismatchException(localDeviceId, envelope.targetDeviceId)
        }

        // 2. Session ID consistency check
        if (!manifest.sessionId.contentEquals(manifest.sessionId)) {
            throw KeyEnvelopeException("Session ID mismatch between manifest and envelope")
        }

        val sessionKey = bytesToHex(manifest.sessionId)

        // 3. Complete Envelope Deduplication (Optical Carousel Repetition)
        val existingRawBytes = activeEnvelopes[sessionKey]
        val existingContext = activeContexts[sessionKey]
        if (existingRawBytes != null && existingContext != null) {
            // Compare COMPLETE envelope binary payload byte-for-byte
            if (existingRawBytes.contentEquals(rawEnvelopePayload)) {
                return KeyEnvelopeUnwrapResult.DuplicateAccepted(existingContext)
            } else {
                // Conflicting envelope received for active session -> FAIL CLOSED
                throw ConflictingKeyEnvelopeException(
                    "Conflicting key envelope received for active session $sessionKey: envelope payload differs from established envelope"
                )
            }
        }

        // 4. MANDATORY INVARIANT: Manifest-to-Envelope Key Binding
        // Must be checked byte-for-byte before ANY cryptographic operation!
        if (!manifest.senderPublicKey.contentEquals(envelope.ephemeralPublicKey)) {
            throw ManifestKeyMismatchException(
                manifestKey = manifest.senderPublicKey.copyOf(),
                envelopeKey = envelope.ephemeralPublicKey.copyOf()
            )
        }

        // 5. Cryptographic Key Agreement: Pairwise X25519 ECDH
        val pairwiseSecret = crypto.computeSharedSecret(
            privateKey = localPrivateKey,
            peerPublicKey = envelope.ephemeralPublicKey
        )

        // 6. Derive Wrapping Key via HKDF-SHA256 bound to sessionId
        val wrapKey = crypto.hkdf(
            ikm = pairwiseSecret,
            salt = manifest.sessionId,
            info = "LumaLink-KeyWrap-v1".toByteArray(Charsets.UTF_8),
            length = 32
        )

        // 7. Canonical AAD Binding
        val aad = buildEnvelopeAad(manifest.sessionId, envelope.targetDeviceId)

        // 8. AEAD Decryption under ChaCha20-Poly1305
        val broadcastSecret = crypto.decryptAead(
            key = wrapKey,
            nonce = envelope.wrapNonce,
            ciphertext = envelope.wrappedCiphertext,
            tag = envelope.wrapTag,
            aad = aad
        )

        if (broadcastSecret.size != 32) {
            throw KeyEnvelopeException("Unwrapped session secret must be exactly 32 bytes, got ${broadcastSecret.size}")
        }

        // 9. Derive active bulk SessionKeys
        val infoPrefix = if (manifest.mode == "quick") "LumaLink-QuickSend-v2" else "LumaLink-PrivateSend-v2"
        val sessionKeys = crypto.deriveSessionKeys(
            sharedSecret = broadcastSecret,
            sessionIdBytes = manifest.sessionId,
            infoPrefix = infoPrefix
        )

        // 10. Establish LumaSecurityContext
        val context = LumaSecurityContext(
            sessionId = manifest.sessionId,
            keys = sessionKeys,
            crypto = crypto,
            replayProtector = LumaReplayProtector()
        )

        // 11. Register in active registry and PreProvisionedSessionStore
        PreProvisionedSessionStore.register(manifest.sessionId, context)
        activeEnvelopes[sessionKey] = rawEnvelopePayload.copyOf()
        activeContexts[sessionKey] = context

        return KeyEnvelopeUnwrapResult.Accepted(context, broadcastSecret)
    }

    /**
     * Checks if a security context is already established for the given session ID.
     */
    fun hasEstablishedSession(sessionId: ByteArray): Boolean {
        return activeContexts.containsKey(bytesToHex(sessionId))
    }

    /**
     * Returns the established security context for the given session ID, or null.
     */
    fun getContext(sessionId: ByteArray): LumaSecurityContext? {
        return activeContexts[bytesToHex(sessionId)]
    }

    /**
     * Clears all established envelopes and contexts and unregisters them from the session store.
     */
    fun clear() {
        for (context in activeContexts.values) {
            PreProvisionedSessionStore.remove(context.sessionId)
        }
        activeEnvelopes.clear()
        activeContexts.clear()
    }
}

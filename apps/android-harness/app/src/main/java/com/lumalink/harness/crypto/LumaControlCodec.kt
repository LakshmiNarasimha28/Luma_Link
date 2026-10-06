package com.lumalink.harness.crypto

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

// ============================================================================
// Exceptions
// ============================================================================

open class LumaControlException(message: String, cause: Throwable? = null) : Exception(message, cause)

class TruncatedControlException(val expected: Int, val actual: Int) :
    LumaControlException("Truncated control message: expected at least $expected bytes, received $actual")

class TrailingDataControlException(val expected: Int, val actual: Int) :
    LumaControlException("Trailing data detected: control message length is $expected bytes, received buffer of $actual bytes")

class UnsupportedControlVersionException(val version: Int) :
    LumaControlException("Unsupported control version: $version (expected ${LumaControlCodec.CURRENT_VERSION})")

class InvalidControlMessageTypeException(val messageType: Int) :
    LumaControlException("Invalid control message type: $messageType")

class InvalidControlFieldException(val fieldName: String, val value: Any?, val reason: String) :
    LumaControlException("Invalid control field '$fieldName': $reason (value: $value)")

class MalformedControlException(message: String) : LumaControlException(message)

// ============================================================================
// Data Models
// ============================================================================

data class LumaAuthRequest(
    val sessionId: ByteArray,
    val receiverDeviceId: String,
    val receiverPublicKey: ByteArray,
    val timestamp: Long
) {
    init {
        require(sessionId.size == 16) { "Session ID must be 16 bytes, received ${sessionId.size}" }
        require(receiverPublicKey.size == 32) { "receiverPublicKey must be 32 bytes, received ${receiverPublicKey.size}" }
        require(timestamp >= 0) { "timestamp must be >= 0, received $timestamp" }
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false
        other as LumaAuthRequest
        if (!sessionId.contentEquals(other.sessionId)) return false
        if (receiverDeviceId != other.receiverDeviceId) return false
        if (!receiverPublicKey.contentEquals(other.receiverPublicKey)) return false
        if (timestamp != other.timestamp) return false
        return true
    }

    override fun hashCode(): Int {
        var result = sessionId.contentHashCode()
        result = 31 * result + receiverDeviceId.hashCode()
        result = 31 * result + receiverPublicKey.contentHashCode()
        result = 31 * result + timestamp.hashCode()
        return result
    }
}

data class LumaEncryptedKeyEnvelope(
    val targetDeviceId: String,
    val ephemeralPublicKey: ByteArray,
    val wrapNonce: ByteArray,
    val wrapTag: ByteArray,
    val wrappedCiphertext: ByteArray,
    val rawBytes: ByteArray? = null
) {
    init {
        require(ephemeralPublicKey.size == 32) { "ephemeralPublicKey must be 32 bytes, received ${ephemeralPublicKey.size}" }
        require(wrapNonce.size == 12) { "wrapNonce must be 12 bytes, received ${wrapNonce.size}" }
        require(wrapTag.size == 16) { "wrapTag must be 16 bytes, received ${wrapTag.size}" }
        require(wrappedCiphertext.size == 32) { "wrappedCiphertext must be 32 bytes, received ${wrappedCiphertext.size}" }
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false
        other as LumaEncryptedKeyEnvelope
        if (targetDeviceId != other.targetDeviceId) return false
        if (!ephemeralPublicKey.contentEquals(other.ephemeralPublicKey)) return false
        if (!wrapNonce.contentEquals(other.wrapNonce)) return false
        if (!wrapTag.contentEquals(other.wrapTag)) return false
        if (!wrappedCiphertext.contentEquals(other.wrappedCiphertext)) return false
        return true
    }

    override fun hashCode(): Int {
        var result = targetDeviceId.hashCode()
        result = 31 * result + ephemeralPublicKey.contentHashCode()
        result = 31 * result + wrapNonce.contentHashCode()
        result = 31 * result + wrapTag.contentHashCode()
        result = 31 * result + wrappedCiphertext.contentHashCode()
        return result
    }
}

data class LumaAuthResponse(
    val sessionId: ByteArray,
    val receiverDeviceId: String,
    val authState: Int, // 1 = authorized, 2 = rejected, 3 = pending
    val reasonCode: Int = 0,
    val keyEnvelope: LumaEncryptedKeyEnvelope? = null,
    val rawEnvelopeBytes: ByteArray? = null
) {
    init {
        require(sessionId.size == 16) { "Session ID must be 16 bytes, received ${sessionId.size}" }
        require(authState in 1..3) { "authState must be 1 (authorized), 2 (rejected), or 3 (pending), received $authState" }
    }

    val isAuthorized: Boolean get() = authState == LumaControlCodec.AUTH_STATE_AUTHORIZED
    val isRejected: Boolean get() = authState == LumaControlCodec.AUTH_STATE_REJECTED
    val isPending: Boolean get() = authState == LumaControlCodec.AUTH_STATE_PENDING

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false
        other as LumaAuthResponse
        if (!sessionId.contentEquals(other.sessionId)) return false
        if (receiverDeviceId != other.receiverDeviceId) return false
        if (authState != other.authState) return false
        if (reasonCode != other.reasonCode) return false
        if (keyEnvelope != other.keyEnvelope) return false
        return true
    }

    override fun hashCode(): Int {
        var result = sessionId.contentHashCode()
        result = 31 * result + receiverDeviceId.hashCode()
        result = 31 * result + authState
        result = 31 * result + reasonCode
        result = 31 * result + (keyEnvelope?.hashCode() ?: 0)
        return result
    }
}

// ============================================================================
// Codec Implementation
// ============================================================================

/**
 * Deterministic binary serializer and deserializer for LumaLink CONTROL plane messages:
 * - AUTH_REQUEST (0x01)
 * - AUTH_RESPONSE / KEY_ENVELOPE (0x02)
 *
 * Byte-for-byte compatible with TypeScript [ControlCodec].
 */
object LumaControlCodec {

    const val CURRENT_VERSION = 1

    const val TYPE_AUTH_REQUEST = 0x01
    const val TYPE_AUTH_RESPONSE = 0x02

    const val AUTH_STATE_AUTHORIZED = 0x01
    const val AUTH_STATE_REJECTED = 0x02
    const val AUTH_STATE_PENDING = 0x03

    const val AUTH_REQUEST_FIXED_SIZE = 61
    const val AUTH_RESPONSE_AUTHORIZED_FIXED_SIZE = 113
    const val AUTH_RESPONSE_NON_AUTHORIZED_FIXED_SIZE = 21

    const val MIN_DEVICE_ID_LENGTH = 1
    const val MAX_DEVICE_ID_LENGTH = 64

    private val UTF8_DECODER = Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)

    /**
     * Reads the 1-byte control message type discriminator without full decoding.
     */
    fun getControlMessageType(raw: ByteArray): Int {
        if (raw.isEmpty()) {
            throw TruncatedControlException(1, 0)
        }
        return raw[0].toInt() and 0xFF
    }

    // ========================================================================
    // AUTH_REQUEST (0x01)
    // ========================================================================

    /**
     * Encodes an AuthRequest into a deterministic binary buffer.
     */
    fun encodeAuthRequest(request: LumaAuthRequest): ByteArray {
        if (request.timestamp < 0) {
            throw InvalidControlFieldException("timestamp", request.timestamp, "Must be >= 0")
        }
        if (request.receiverPublicKey.size != 32) {
            throw InvalidControlFieldException("receiverPublicKey", request.receiverPublicKey.size, "Must be exactly 32 bytes")
        }

        val deviceIdBytes = request.receiverDeviceId.toByteArray(Charsets.UTF_8)
        if (deviceIdBytes.size < MIN_DEVICE_ID_LENGTH) {
            throw InvalidControlFieldException("receiverDeviceId", request.receiverDeviceId, "Length must be at least $MIN_DEVICE_ID_LENGTH byte")
        }
        if (deviceIdBytes.size > MAX_DEVICE_ID_LENGTH) {
            throw InvalidControlFieldException("receiverDeviceId", request.receiverDeviceId, "Length (${deviceIdBytes.size}) exceeds maximum $MAX_DEVICE_ID_LENGTH bytes")
        }

        val totalLength = AUTH_REQUEST_FIXED_SIZE + deviceIdBytes.size
        val buffer = ByteArray(totalLength)
        val byteBuf = ByteBuffer.wrap(buffer).order(ByteOrder.BIG_ENDIAN)

        // [0] MessageType
        buffer[0] = TYPE_AUTH_REQUEST.toByte()
        // [1] Version
        buffer[1] = CURRENT_VERSION.toByte()
        // [2..3] Reserved (0x0000)
        byteBuf.putShort(2, 0.toShort())
        // [4..19] Session ID
        System.arraycopy(request.sessionId, 0, buffer, 4, 16)
        // [20..27] Timestamp (uint64 BE)
        byteBuf.putLong(20, request.timestamp)
        // [28..59] Receiver Public Key (32 bytes)
        System.arraycopy(request.receiverPublicKey, 0, buffer, 28, 32)
        // [60] Device ID Length
        buffer[60] = deviceIdBytes.size.toByte()
        // [61..] Device ID
        System.arraycopy(deviceIdBytes, 0, buffer, 61, deviceIdBytes.size)

        return buffer
    }

    /**
     * Decodes an AuthRequest from a raw binary buffer with strict validation.
     */
    fun decodeAuthRequest(raw: ByteArray): LumaAuthRequest {
        if (raw.size < AUTH_REQUEST_FIXED_SIZE + MIN_DEVICE_ID_LENGTH) {
            throw TruncatedControlException(AUTH_REQUEST_FIXED_SIZE + MIN_DEVICE_ID_LENGTH, raw.size)
        }

        val byteBuf = ByteBuffer.wrap(raw).order(ByteOrder.BIG_ENDIAN)

        // 1. Message Type
        val messageType = raw[0].toInt() and 0xFF
        if (messageType != TYPE_AUTH_REQUEST) {
            throw InvalidControlMessageTypeException(messageType)
        }

        // 2. Version
        val version = raw[1].toInt() and 0xFF
        if (version != CURRENT_VERSION) {
            throw UnsupportedControlVersionException(version)
        }

        // 3. Reserved (must be 0x0000)
        val reserved = byteBuf.getShort(2).toInt() and 0xFFFF
        if (reserved != 0) {
            throw MalformedControlException("Invalid reserved field: expected 0x0000, received 0x${Integer.toHexString(reserved)}")
        }

        // 4. Session ID
        val sessionId = raw.copyOfRange(4, 20)

        // 5. Timestamp
        val timestamp = byteBuf.getLong(20)

        // 6. Receiver Public Key
        val receiverPublicKey = raw.copyOfRange(28, 60)

        // 7. Device ID
        val deviceIdLength = raw[60].toInt() and 0xFF
        if (deviceIdLength < MIN_DEVICE_ID_LENGTH || deviceIdLength > MAX_DEVICE_ID_LENGTH) {
            throw InvalidControlFieldException("receiverDeviceIdLength", deviceIdLength, "Must be between $MIN_DEVICE_ID_LENGTH and $MAX_DEVICE_ID_LENGTH bytes")
        }

        val expectedTotal = AUTH_REQUEST_FIXED_SIZE + deviceIdLength
        if (raw.size < expectedTotal) {
            throw TruncatedControlException(expectedTotal, raw.size)
        }
        if (raw.size > expectedTotal) {
            throw TrailingDataControlException(expectedTotal, raw.size)
        }

        val deviceIdRaw = raw.copyOfRange(61, expectedTotal)
        val receiverDeviceId = try {
            synchronized(UTF8_DECODER) {
                UTF8_DECODER.reset()
                UTF8_DECODER.decode(ByteBuffer.wrap(deviceIdRaw)).toString()
            }
        } catch (_: CharacterCodingException) {
            throw MalformedControlException("Invalid UTF-8 sequence in receiverDeviceId")
        }

        return LumaAuthRequest(
            sessionId = sessionId,
            receiverDeviceId = receiverDeviceId,
            receiverPublicKey = receiverPublicKey,
            timestamp = timestamp
        )
    }

    // ========================================================================
    // AUTH_RESPONSE / KEY_ENVELOPE (0x02)
    // ========================================================================

    /**
     * Encodes an AuthResponse (and optional EncryptedKeyEnvelope) into a deterministic binary buffer.
     */
    fun encodeAuthResponse(response: LumaAuthResponse): ByteArray {
        val stateByte = response.authState
        if (stateByte !in 1..3) {
            throw InvalidControlFieldException("authState", stateByte, "Must be 1 (authorized), 2 (rejected), or 3 (pending)")
        }

        val targetDeviceId = response.keyEnvelope?.targetDeviceId ?: response.receiverDeviceId
        val deviceIdBytes = targetDeviceId.toByteArray(Charsets.UTF_8)
        if (deviceIdBytes.size < MIN_DEVICE_ID_LENGTH) {
            throw InvalidControlFieldException("targetDeviceId", targetDeviceId, "Length must be at least $MIN_DEVICE_ID_LENGTH byte")
        }
        if (deviceIdBytes.size > MAX_DEVICE_ID_LENGTH) {
            throw InvalidControlFieldException("targetDeviceId", targetDeviceId, "Length (${deviceIdBytes.size}) exceeds maximum $MAX_DEVICE_ID_LENGTH bytes")
        }

        val isAuthorized = stateByte == AUTH_STATE_AUTHORIZED
        if (isAuthorized && response.keyEnvelope == null) {
            throw InvalidControlFieldException("keyEnvelope", null, "keyEnvelope is required when authState is AUTHORIZED")
        }

        val envelope = response.keyEnvelope
        if (isAuthorized && envelope != null) {
            if (envelope.ephemeralPublicKey.size != 32) {
                throw InvalidControlFieldException("ephemeralPublicKey", envelope.ephemeralPublicKey.size, "Must be exactly 32 bytes")
            }
            if (envelope.wrapNonce.size != 12) {
                throw InvalidControlFieldException("wrapNonce", envelope.wrapNonce.size, "Must be exactly 12 bytes")
            }
            if (envelope.wrapTag.size != 16) {
                throw InvalidControlFieldException("wrapTag", envelope.wrapTag.size, "Must be exactly 16 bytes")
            }
            if (envelope.wrappedCiphertext.size != 32) {
                throw InvalidControlFieldException("wrappedCiphertext", envelope.wrappedCiphertext.size, "Must be exactly 32 bytes")
            }
        }

        val totalLength = if (isAuthorized) {
            AUTH_RESPONSE_AUTHORIZED_FIXED_SIZE + deviceIdBytes.size
        } else {
            AUTH_RESPONSE_NON_AUTHORIZED_FIXED_SIZE + deviceIdBytes.size
        }

        val buffer = ByteArray(totalLength)

        // [0] MessageType
        buffer[0] = TYPE_AUTH_RESPONSE.toByte()
        // [1] Version
        buffer[1] = CURRENT_VERSION.toByte()
        // [2] AuthState
        buffer[2] = stateByte.toByte()
        // [3] StatusFlags / Reason
        buffer[3] = (response.reasonCode and 0xFF).toByte()
        // [4..19] Session ID
        System.arraycopy(response.sessionId, 0, buffer, 4, 16)
        // [20] Target Device ID Length
        buffer[20] = deviceIdBytes.size.toByte()
        // [21..20+N] Target Device ID
        System.arraycopy(deviceIdBytes, 0, buffer, 21, deviceIdBytes.size)

        if (isAuthorized && envelope != null) {
            var offset = 21 + deviceIdBytes.size
            // Ephemeral Public Key (32 bytes)
            System.arraycopy(envelope.ephemeralPublicKey, 0, buffer, offset, 32)
            offset += 32
            // Wrap Nonce (12 bytes)
            System.arraycopy(envelope.wrapNonce, 0, buffer, offset, 12)
            offset += 12
            // Wrap Tag (16 bytes)
            System.arraycopy(envelope.wrapTag, 0, buffer, offset, 16)
            offset += 16
            // Wrapped Ciphertext (32 bytes)
            System.arraycopy(envelope.wrappedCiphertext, 0, buffer, offset, 32)
        }

        return buffer
    }

    /**
     * Decodes an AuthResponse from a raw binary buffer with strict validation.
     */
    fun decodeAuthResponse(raw: ByteArray): LumaAuthResponse {
        if (raw.size < AUTH_RESPONSE_NON_AUTHORIZED_FIXED_SIZE + MIN_DEVICE_ID_LENGTH) {
            throw TruncatedControlException(AUTH_RESPONSE_NON_AUTHORIZED_FIXED_SIZE + MIN_DEVICE_ID_LENGTH, raw.size)
        }

        // 1. Message Type
        val messageType = raw[0].toInt() and 0xFF
        if (messageType != TYPE_AUTH_RESPONSE) {
            throw InvalidControlMessageTypeException(messageType)
        }

        // 2. Version
        val version = raw[1].toInt() and 0xFF
        if (version != CURRENT_VERSION) {
            throw UnsupportedControlVersionException(version)
        }

        // 3. Auth State
        val stateByte = raw[2].toInt() and 0xFF
        if (stateByte !in 1..3) {
            throw InvalidControlFieldException("authState", stateByte, "Expected 1 (authorized), 2 (rejected), or 3 (pending)")
        }

        // 4. StatusFlags / Reason Code
        val reasonCode = raw[3].toInt() and 0xFF

        // 5. Session ID
        val sessionId = raw.copyOfRange(4, 20)

        // 6. Target Device ID
        val deviceIdLength = raw[20].toInt() and 0xFF
        if (deviceIdLength < MIN_DEVICE_ID_LENGTH || deviceIdLength > MAX_DEVICE_ID_LENGTH) {
            throw InvalidControlFieldException("targetDeviceIdLength", deviceIdLength, "Must be between $MIN_DEVICE_ID_LENGTH and $MAX_DEVICE_ID_LENGTH bytes")
        }

        val isAuthorized = stateByte == AUTH_STATE_AUTHORIZED
        val expectedTotal = if (isAuthorized) {
            AUTH_RESPONSE_AUTHORIZED_FIXED_SIZE + deviceIdLength
        } else {
            AUTH_RESPONSE_NON_AUTHORIZED_FIXED_SIZE + deviceIdLength
        }

        if (raw.size < expectedTotal) {
            throw TruncatedControlException(expectedTotal, raw.size)
        }
        if (raw.size > expectedTotal) {
            throw TrailingDataControlException(expectedTotal, raw.size)
        }

        val deviceIdRaw = raw.copyOfRange(21, 21 + deviceIdLength)
        val targetDeviceId = try {
            synchronized(UTF8_DECODER) {
                UTF8_DECODER.reset()
                UTF8_DECODER.decode(ByteBuffer.wrap(deviceIdRaw)).toString()
            }
        } catch (_: CharacterCodingException) {
            throw MalformedControlException("Invalid UTF-8 sequence in targetDeviceId")
        }

        var keyEnvelope: LumaEncryptedKeyEnvelope? = null

        if (isAuthorized) {
            var offset = 21 + deviceIdLength
            val ephemeralPublicKey = raw.copyOfRange(offset, offset + 32)
            offset += 32
            val wrapNonce = raw.copyOfRange(offset, offset + 12)
            offset += 12
            val wrapTag = raw.copyOfRange(offset, offset + 16)
            offset += 16
            val wrappedCiphertext = raw.copyOfRange(offset, offset + 32)

            keyEnvelope = LumaEncryptedKeyEnvelope(
                targetDeviceId = targetDeviceId,
                ephemeralPublicKey = ephemeralPublicKey,
                wrapNonce = wrapNonce,
                wrapTag = wrapTag,
                wrappedCiphertext = wrappedCiphertext,
                rawBytes = raw.copyOf(expectedTotal)
            )
        }

        return LumaAuthResponse(
            sessionId = sessionId,
            receiverDeviceId = targetDeviceId,
            authState = stateByte,
            reasonCode = reasonCode,
            keyEnvelope = keyEnvelope,
            rawEnvelopeBytes = raw.copyOf(expectedTotal)
        )
    }
}

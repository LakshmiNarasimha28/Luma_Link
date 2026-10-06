package com.lumalink.harness.session

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

// ============================================================================
// Manifest Codec Exceptions
// ============================================================================

open class LumaManifestException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)

class TruncatedManifestException(val expected: Int, val actual: Int) :
    LumaManifestException("Truncated manifest: expected at least $expected bytes, received $actual")

class TrailingDataManifestException(val expected: Int, val actual: Int) :
    LumaManifestException("Trailing data detected: manifest length is $expected bytes, received buffer of $actual bytes")

class UnsupportedManifestVersionException(val version: Int) :
    LumaManifestException("Unsupported manifest version: $version (expected ${LumaManifestCodec.CURRENT_VERSION})")

class InvalidManifestFieldException(val fieldName: String, val value: Any?, val reason: String) :
    LumaManifestException("Invalid manifest field '$fieldName': $reason (value: $value)")

class MalformedManifestException(message: String, cause: Throwable? = null) :
    LumaManifestException(message, cause)

// ============================================================================
// LumaManifestCodec
// ============================================================================

/**
 * Deterministic binary serializer and deserializer for [LumaSessionAnnouncement].
 *
 * Wire Layout (Big-Endian):
 *   [0]        Manifest Version (uint8 = 1)
 *   [1]        Security Mode (uint8: 1 = 'quick', 2 = 'private')
 *   [2..3]     Reserved (uint16 BE = 0x0000)
 *   [4..19]    Session ID (16 bytes)
 *   [20..27]   Timestamp (uint64 BE, ms since UNIX epoch)
 *   [28..35]   File Size (uint64 BE, bytes)
 *   [36..39]   Total Blocks (uint32 BE)
 *   [40..41]   Symbol Size (uint16 BE)
 *   [42..43]   Symbols Per Block (uint16 BE)
 *   [44..75]   Sender Public Key (32 bytes X25519)
 *   [76..107]  SHA-256 Digest (32 raw bytes)
 *   [108]      Sender Device ID Length N1 (uint8, 0..64)
 *   [109..109+N1-1] Sender Device ID (UTF-8 bytes)
 *   [109+N1..110+N1] File Name Length N2 (uint16 BE, 1..255)
 *   [111+N1..110+N1+N2] File Name (UTF-8 bytes)
 *
 * Total size: 111 + N1 + N2 bytes (Min: 112 bytes, Max: 430 bytes).
 * Byte-for-byte compatible with TypeScript [ManifestCodec].
 */
object LumaManifestCodec {

    const val CURRENT_VERSION = 1
    const val FIXED_HEADER_SIZE = 111
    const val MAX_DEVICE_ID_LENGTH = 64
    const val MIN_FILE_NAME_LENGTH = 1
    const val MAX_FILE_NAME_LENGTH = 255

    private fun bytesToHex(bytes: ByteArray): String {
        val sb = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xFF
            if (v < 16) sb.append('0')
            sb.append(Integer.toHexString(v))
        }
        return sb.toString()
    }

    private fun hexToBytes(hex: String): ByteArray {
        val clean = hex.trim().lowercase()
        if (clean.length != 64 || !clean.all { it in '0'..'9' || it in 'a'..'f' }) {
            throw InvalidManifestFieldException(
                "sha256Digest",
                hex,
                "Must be a 64-character lowercase hexadecimal string"
            )
        }
        val bytes = ByteArray(32)
        var i = 0
        while (i < 32) {
            bytes[i] = ((Character.digit(clean[i * 2], 16) shl 4) +
                    Character.digit(clean[i * 2 + 1], 16)).toByte()
            i++
        }
        return bytes
    }

    /**
     * Serializes a [LumaSessionAnnouncement] into a deterministic binary buffer.
     */
    fun encode(announcement: LumaSessionAnnouncement): ByteArray {
        // 1. Validate fields
        val modeByte = when (announcement.mode) {
            "quick" -> 1
            "private" -> 2
            else -> throw InvalidManifestFieldException(
                "mode",
                announcement.mode,
                "Must be 'quick' or 'private'"
            )
        }

        if (announcement.fileSize < 0) {
            throw InvalidManifestFieldException("fileSize", announcement.fileSize, "Must be >= 0")
        }
        if (announcement.totalBlocks < 1) {
            throw InvalidManifestFieldException("totalBlocks", announcement.totalBlocks, "Must be >= 1")
        }
        if (announcement.symbolSize < 1) {
            throw InvalidManifestFieldException("symbolSize", announcement.symbolSize, "Must be >= 1")
        }
        if (announcement.symbolsPerBlock < 1) {
            throw InvalidManifestFieldException("symbolsPerBlock", announcement.symbolsPerBlock, "Must be >= 1")
        }
        if (announcement.timestamp < 0) {
            throw InvalidManifestFieldException("timestamp", announcement.timestamp, "Must be >= 0")
        }
        if (announcement.senderPublicKey.size != 32) {
            throw InvalidManifestFieldException(
                "senderPublicKey",
                announcement.senderPublicKey.size,
                "Must be exactly 32 bytes"
            )
        }
        if (announcement.sessionId.size != 16) {
            throw InvalidManifestFieldException(
                "sessionId",
                announcement.sessionId.size,
                "Must be exactly 16 bytes"
            )
        }

        val sha256Bytes = hexToBytes(announcement.sha256Digest)

        // 2. Encode UTF-8 strings
        val deviceIdBytes = announcement.senderDeviceId.toByteArray(Charsets.UTF_8)
        if (deviceIdBytes.size > MAX_DEVICE_ID_LENGTH) {
            throw InvalidManifestFieldException(
                "senderDeviceId",
                announcement.senderDeviceId,
                "UTF-8 length (${deviceIdBytes.size}) exceeds maximum allowable $MAX_DEVICE_ID_LENGTH bytes"
            )
        }

        val fileNameBytes = announcement.fileName.toByteArray(Charsets.UTF_8)
        if (fileNameBytes.size < MIN_FILE_NAME_LENGTH) {
            throw InvalidManifestFieldException(
                "fileName",
                announcement.fileName,
                "UTF-8 length must be at least $MIN_FILE_NAME_LENGTH byte"
            )
        }
        if (fileNameBytes.size > MAX_FILE_NAME_LENGTH) {
            throw InvalidManifestFieldException(
                "fileName",
                announcement.fileName,
                "UTF-8 length (${fileNameBytes.size}) exceeds maximum allowable $MAX_FILE_NAME_LENGTH bytes"
            )
        }

        // 3. Allocate buffer
        val totalLength = FIXED_HEADER_SIZE + deviceIdBytes.size + fileNameBytes.size
        val buffer = ByteBuffer.allocate(totalLength).order(ByteOrder.BIG_ENDIAN)

        // [0] Manifest Version
        buffer.put(CURRENT_VERSION.toByte())

        // [1] Security Mode
        buffer.put(modeByte.toByte())

        // [2..3] Reserved (0x0000)
        buffer.putShort(0x0000.toShort())

        // [4..19] Session ID (16 bytes)
        buffer.put(announcement.sessionId)

        // [20..27] Timestamp (uint64 BE)
        buffer.putLong(announcement.timestamp)

        // [28..35] File Size (uint64 BE)
        buffer.putLong(announcement.fileSize)

        // [36..39] Total Blocks (uint32 BE)
        buffer.putInt(announcement.totalBlocks)

        // [40..41] Symbol Size (uint16 BE)
        buffer.putShort(announcement.symbolSize.toShort())

        // [42..43] Symbols Per Block (uint16 BE)
        buffer.putShort(announcement.symbolsPerBlock.toShort())

        // [44..75] Sender Public Key (32 bytes)
        buffer.put(announcement.senderPublicKey)

        // [76..107] SHA-256 Digest (32 bytes)
        buffer.put(sha256Bytes)

        // [108] Sender Device ID Length N1
        buffer.put(deviceIdBytes.size.toByte())

        // [109..109+N1-1] Sender Device ID
        buffer.put(deviceIdBytes)

        // [109+N1..110+N1] File Name Length N2 (uint16 BE)
        buffer.putShort(fileNameBytes.size.toShort())

        // [111+N1..110+N1+N2] File Name
        buffer.put(fileNameBytes)

        return buffer.array()
    }

    /**
     * Deserializes and strictly validates a raw binary buffer into a [LumaSessionAnnouncement].
     */
    fun decode(raw: ByteArray): LumaSessionAnnouncement {
        if (raw.size < FIXED_HEADER_SIZE + MIN_FILE_NAME_LENGTH) {
            throw TruncatedManifestException(FIXED_HEADER_SIZE + MIN_FILE_NAME_LENGTH, raw.size)
        }

        val buffer = ByteBuffer.wrap(raw).order(ByteOrder.BIG_ENDIAN)

        // 1. Verify Manifest Version
        val version = buffer.get(0).toInt() and 0xFF
        if (version != CURRENT_VERSION) {
            throw UnsupportedManifestVersionException(version)
        }

        // 2. Verify Security Mode
        val modeByte = buffer.get(1).toInt() and 0xFF
        val mode = when (modeByte) {
            1 -> "quick"
            2 -> "private"
            else -> throw InvalidManifestFieldException("mode", modeByte, "Expected 1 (quick) or 2 (private)")
        }

        // 3. Verify Reserved Field (must be 0x0000)
        val reserved = buffer.getShort(2).toInt() and 0xFFFF
        if (reserved != 0x0000) {
            throw MalformedManifestException("Invalid reserved field: expected 0x0000, received 0x${Integer.toHexString(reserved)}")
        }

        // 4. Session ID (16 bytes)
        val sessionId = ByteArray(16)
        buffer.position(4)
        buffer.get(sessionId)

        // 5. Numeric Fields
        val timestamp = buffer.getLong(20)
        if (timestamp < 0) {
            throw InvalidManifestFieldException("timestamp", timestamp, "Must be >= 0")
        }

        val fileSize = buffer.getLong(28)
        if (fileSize < 0) {
            throw InvalidManifestFieldException("fileSize", fileSize, "Must be >= 0")
        }

        val totalBlocks = buffer.getInt(36)
        if (totalBlocks < 1) {
            throw InvalidManifestFieldException("totalBlocks", totalBlocks, "Must be >= 1")
        }

        val symbolSize = buffer.getShort(40).toInt() and 0xFFFF
        if (symbolSize < 1) {
            throw InvalidManifestFieldException("symbolSize", symbolSize, "Must be >= 1")
        }

        val symbolsPerBlock = buffer.getShort(42).toInt() and 0xFFFF
        if (symbolsPerBlock < 1) {
            throw InvalidManifestFieldException("symbolsPerBlock", symbolsPerBlock, "Must be >= 1")
        }

        // 6. Cryptographic Material
        val senderPublicKey = ByteArray(32)
        buffer.position(44)
        buffer.get(senderPublicKey)

        val sha256Bytes = ByteArray(32)
        buffer.position(76)
        buffer.get(sha256Bytes)
        val sha256Digest = bytesToHex(sha256Bytes)

        // 7. Variable Length Field 1: senderDeviceId
        val deviceIdLength = buffer.get(108).toInt() and 0xFF
        if (deviceIdLength > MAX_DEVICE_ID_LENGTH) {
            throw InvalidManifestFieldException(
                "senderDeviceIdLength",
                deviceIdLength,
                "Exceeds maximum $MAX_DEVICE_ID_LENGTH bytes"
            )
        }

        var offset = 109
        if (raw.size < offset + deviceIdLength + 2) {
            throw TruncatedManifestException(offset + deviceIdLength + 2, raw.size)
        }

        var senderDeviceId = ""
        if (deviceIdLength > 0) {
            val decoder = Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
            try {
                senderDeviceId = decoder.decode(ByteBuffer.wrap(raw, offset, deviceIdLength)).toString()
            } catch (e: CharacterCodingException) {
                throw MalformedManifestException("Invalid UTF-8 sequence in senderDeviceId", e)
            }
            offset += deviceIdLength
        }

        // 8. Variable Length Field 2: fileName
        buffer.position(offset)
        val fileNameLength = buffer.short.toInt() and 0xFFFF
        offset += 2

        if (fileNameLength < MIN_FILE_NAME_LENGTH || fileNameLength > MAX_FILE_NAME_LENGTH) {
            throw InvalidManifestFieldException(
                "fileNameLength",
                fileNameLength,
                "Must be between $MIN_FILE_NAME_LENGTH and $MAX_FILE_NAME_LENGTH bytes"
            )
        }

        val expectedTotalLength = offset + fileNameLength
        if (raw.size < expectedTotalLength) {
            throw TruncatedManifestException(expectedTotalLength, raw.size)
        }
        if (raw.size > expectedTotalLength) {
            throw TrailingDataManifestException(expectedTotalLength, raw.size)
        }

        val fileName: String
        val decoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        try {
            fileName = decoder.decode(ByteBuffer.wrap(raw, offset, fileNameLength)).toString()
        } catch (e: CharacterCodingException) {
            throw MalformedManifestException("Invalid UTF-8 sequence in fileName", e)
        }

        return LumaSessionAnnouncement(
            sessionId = sessionId,
            mode = mode,
            senderDeviceId = senderDeviceId,
            senderPublicKey = senderPublicKey,
            fileName = fileName,
            fileSize = fileSize,
            sha256Digest = sha256Digest,
            symbolSize = symbolSize,
            symbolsPerBlock = symbolsPerBlock,
            totalBlocks = totalBlocks,
            timestamp = timestamp
        )
    }
}

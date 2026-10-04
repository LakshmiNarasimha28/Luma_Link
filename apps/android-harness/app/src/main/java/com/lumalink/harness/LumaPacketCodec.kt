package com.lumalink.harness

import java.nio.ByteBuffer
import java.nio.ByteOrder

// ============================================================================
// Exceptions
// ============================================================================

open class LumaPacketException(message: String, cause: Throwable? = null) : Exception(message, cause)

class MalformedPacketException(message: String) : LumaPacketException(message)

class UnsupportedProtocolVersionException(val version: Int) :
    LumaPacketException("Unsupported protocol version: $version (expected ${LumaPacketCodec.CURRENT_PROTOCOL_VERSION})")

class InvalidPacketTypeException(val typeCode: Int) :
    LumaPacketException("Invalid packet type code: $typeCode")

class TruncatedPacketException(val expected: Int, val actual: Int) :
    LumaPacketException("Truncated packet: expected at least $expected bytes, received $actual")

class TrailingDataException(val expected: Int, val actual: Int) :
    LumaPacketException("Trailing data detected: packet length is $expected bytes, received buffer of $actual bytes")

class ChecksumMismatchException(val expected: Long, val actual: Long) :
    LumaPacketException("Checksum mismatch: expected 0x${java.lang.Long.toHexString(expected)}, got 0x${java.lang.Long.toHexString(actual)}")

// ============================================================================
// Codec Implementation
// ============================================================================

object LumaPacketCodec {
    const val PACKET_HEADER_SIZE = 42
    const val CURRENT_PROTOCOL_VERSION = 1

    const val TYPE_MANIFEST = 1
    const val TYPE_DATA = 2
    const val TYPE_SYNC = 3
    const val TYPE_CONTROL = 4

    const val FLAG_ENCRYPTED = 0x02

    private val MAGIC = byteArrayOf(0x4C, 0x55, 0x4D, 0x41) // 'L', 'U', 'M', 'A'

    // IEEE 802.3 CRC-32 Table matching TypeScript BinaryPacketCodec
    private val CRC32_TABLE = LongArray(256) { i ->
        var c = i.toLong()
        for (j in 0 until 8) {
            c = if ((c and 1L) != 0L) {
                0xEDB88320L xor (c ushr 1)
            } else {
                c ushr 1
            }
        }
        c and 0xFFFFFFFFL
    }

    /**
     * Computes IEEE 802.3 CRC-32 identically to TypeScript [computeCrc32].
     */
    fun computeCrc32(data: ByteArray, offset: Int = 0, length: Int = data.size - offset, previousCrc: Long = 0L): Long {
        var crc = (previousCrc xor 0xFFFFFFFFL) and 0xFFFFFFFFL
        val end = offset + length
        for (i in offset until end) {
            val byteVal = (data[i].toInt() and 0xFF).toLong()
            val tableIndex = ((crc xor byteVal) and 0xFFL).toInt()
            crc = (CRC32_TABLE[tableIndex] xor (crc ushr 8)) and 0xFFFFFFFFL
        }
        return (crc xor 0xFFFFFFFFL) and 0xFFFFFFFFL
    }

    /**
     * Computes the packet checksum over header prefix [0..37] and payload [42..42+payloadLength]
     * using the exact chained CRC definition from TypeScript BinaryPacketCodec:
     *   crc1 = computeCrc32(headerPrefix, 0)
     *   checksum = computeCrc32(payload, crc1 ^ 0xFFFFFFFF)
     */
    fun computePacketChecksum(data: ByteArray, payloadLength: Int): Long {
        val crc1 = computeCrc32(data, 0, 38, 0L)
        return computeCrc32(data, PACKET_HEADER_SIZE, payloadLength, crc1 xor 0xFFFFFFFFL)
    }

    /**
     * Decodes and strictly validates a raw binary buffer into a [LumaTransportPacket].
     *
     * @param raw The raw wire byte array.
     * @param allowTrailing Whether to allow extra trailing bytes beyond the packet. Default false.
     * @return Validated [LumaTransportPacket].
     * @throws LumaPacketException if the packet is malformed, truncated, corrupt, or invalid.
     */
    fun decode(raw: ByteArray, allowTrailing: Boolean = false): LumaTransportPacket {
        if (raw.size < PACKET_HEADER_SIZE) {
            throw TruncatedPacketException(PACKET_HEADER_SIZE, raw.size)
        }

        // 1. Verify Magic 'LUMA'
        if (raw[0] != MAGIC[0] || raw[1] != MAGIC[1] || raw[2] != MAGIC[2] || raw[3] != MAGIC[3]) {
            throw MalformedPacketException("Invalid packet magic header: expected 'LUMA'")
        }

        val buffer = ByteBuffer.wrap(raw).order(ByteOrder.BIG_ENDIAN)

        // 2. Verify Protocol Version
        val version = buffer.get(4).toInt() and 0xFF
        if (version != CURRENT_PROTOCOL_VERSION) {
            throw UnsupportedProtocolVersionException(version)
        }

        // 3. Verify Packet Type
        val packetType = buffer.get(5).toInt() and 0xFF
        when (packetType) {
            TYPE_MANIFEST, TYPE_DATA, TYPE_SYNC, TYPE_CONTROL -> { /* Valid */ }
            else -> throw InvalidPacketTypeException(packetType)
        }

        val flags = buffer.get(6).toInt() and 0xFF
        val reserved = buffer.get(7).toInt() and 0xFF

        // 4. Session ID (16 bytes)
        val sessionId = raw.copyOfRange(8, 24)

        // 5. Indices & Metadata (Big-Endian)
        val blockIndex = buffer.getInt(24).toLong() and 0xFFFFFFFFL
        val symbolId = buffer.getInt(28).toLong() and 0xFFFFFFFFL
        val k = buffer.getShort(32).toInt() and 0xFFFF
        val degree = buffer.getShort(34).toInt() and 0xFFFF
        val payloadLength = buffer.getShort(36).toInt() and 0xFFFF
        val storedChecksum = buffer.getInt(38).toLong() and 0xFFFFFFFFL

        // 6. Bounds Validation
        val expectedTotal = PACKET_HEADER_SIZE + payloadLength
        if (raw.size < expectedTotal) {
            throw TruncatedPacketException(expectedTotal, raw.size)
        }
        if (!allowTrailing && raw.size > expectedTotal) {
            throw TrailingDataException(expectedTotal, raw.size)
        }

        // 7. Verify Checksum
        val computedChecksum = computePacketChecksum(raw, payloadLength)
        if (computedChecksum != storedChecksum) {
            throw ChecksumMismatchException(storedChecksum, computedChecksum)
        }

        // 8. Defensive copy payload
        val payload = raw.copyOfRange(PACKET_HEADER_SIZE, expectedTotal)

        return LumaTransportPacket(
            version = version,
            packetType = packetType,
            flags = flags,
            reserved = reserved,
            sessionId = sessionId,
            blockIndex = blockIndex,
            symbolId = symbolId,
            k = k,
            degree = degree,
            payloadLength = payloadLength,
            crc32 = storedChecksum,
            payload = payload,
            rawBytes = raw.copyOf(expectedTotal)
        )
    }
}

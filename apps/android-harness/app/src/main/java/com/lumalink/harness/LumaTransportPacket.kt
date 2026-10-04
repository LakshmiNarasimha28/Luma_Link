package com.lumalink.harness

/**
 * Immutable Kotlin model representing a decoded and validated LumaLink TransportPacket.
 *
 * Wire Header Layout (42 bytes, Big-Endian):
 * - [0..3]   Magic 'LUMA' (0x4c, 0x55, 0x4d, 0x41)
 * - [4]      Protocol Version (uint8)
 * - [5]      Packet Type (uint8: 1=MANIFEST, 2=DATA, 3=SYNC, 4=CONTROL)
 * - [6]      Flags (uint8: 0x02 = FLAG_ENCRYPTED)
 * - [7]      Reserved (uint8)
 * - [8..23]  Session ID (16 bytes, UUID / binary)
 * - [24..27] Block Index (uint32, big-endian)
 * - [28..31] Symbol ID (uint32, big-endian)
 * - [32..33] Total Source Symbols K (uint16, big-endian)
 * - [34..35] Degree (uint16, big-endian)
 * - [36..37] Payload Length (uint16, big-endian)
 * - [38..41] CRC-32 Checksum (uint32, big-endian)
 * - [42..]   Payload bytes
 */
data class LumaTransportPacket(
    val version: Int,
    val packetType: Int,
    val flags: Int,
    val reserved: Int,
    val sessionId: ByteArray,
    val blockIndex: Long,
    val symbolId: Long,
    val k: Int,
    val degree: Int,
    val payloadLength: Int,
    val crc32: Long,
    val payload: ByteArray,
    val rawBytes: ByteArray
) {
    /**
     * Hexadecimal representation of the 16-byte session ID (32 lowercase hex chars).
     */
    val sessionIdHex: String by lazy {
        val sb = StringBuilder(32)
        for (b in sessionId) {
            val v = b.toInt() and 0xFF
            if (v < 16) sb.append('0')
            sb.append(Integer.toHexString(v))
        }
        sb.toString()
    }

    /**
     * Standard RFC 4122 UUID string representation (8-4-4-4-12).
     */
    val sessionIdUuid: String by lazy {
        val h = sessionIdHex
        "${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20, 32)}"
    }

    /**
     * Human-readable packet type name.
     */
    val packetTypeName: String
        get() = when (packetType) {
            LumaPacketCodec.TYPE_MANIFEST -> "MANIFEST"
            LumaPacketCodec.TYPE_DATA -> "DATA"
            LumaPacketCodec.TYPE_SYNC -> "SYNC"
            LumaPacketCodec.TYPE_CONTROL -> "CONTROL"
            else -> "TYPE_$packetType"
        }

    val isEncrypted: Boolean
        get() = (flags and LumaPacketCodec.FLAG_ENCRYPTED) != 0

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false

        other as LumaTransportPacket

        if (version != other.version) return false
        if (packetType != other.packetType) return false
        if (flags != other.flags) return false
        if (reserved != other.reserved) return false
        if (!sessionId.contentEquals(other.sessionId)) return false
        if (blockIndex != other.blockIndex) return false
        if (symbolId != other.symbolId) return false
        if (k != other.k) return false
        if (degree != other.degree) return false
        if (payloadLength != other.payloadLength) return false
        if (crc32 != other.crc32) return false
        if (!payload.contentEquals(other.payload)) return false
        if (!rawBytes.contentEquals(other.rawBytes)) return false

        return true
    }

    override fun hashCode(): Int {
        var result = version
        result = 31 * result + packetType
        result = 31 * result + flags
        result = 31 * result + reserved
        result = 31 * result + sessionId.contentHashCode()
        result = 31 * result + blockIndex.hashCode()
        result = 31 * result + symbolId.hashCode()
        result = 31 * result + k
        result = 31 * result + degree
        result = 31 * result + payloadLength
        result = 31 * result + crc32.hashCode()
        result = 31 * result + payload.contentHashCode()
        result = 31 * result + rawBytes.contentHashCode()
        return result
    }

    override fun toString(): String {
        return "LumaTransportPacket(" +
                "v=$version, type=$packetTypeName($packetType), flags=0x${Integer.toHexString(flags)}, " +
                "session=${sessionIdUuid.take(8)}..., blk=$blockIndex, sym=$symbolId, K=$k, deg=$degree, " +
                "len=$payloadLength, crc=0x${java.lang.Long.toHexString(crc32)})"
    }
}

package com.lumalink.harness.crypto

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Builds the Associated Authenticated Data (AAD) cryptographically binding packet metadata into the AEAD tag.
 *
 * AAD Layout (26 bytes, Big-Endian):
 *   [0..15]  Session ID (16 bytes)
 *   [16..19] Block Index (uint32 BE)
 *   [20..23] Symbol ID (uint32 BE)
 *   [24]     Packet Type Code (uint8, 2 = DATA)
 *   [25]     Flags (uint8, 0x02 = FLAG_ENCRYPTED)
 */
object LumaAad {

    const val AAD_LENGTH_BYTES = 26
    const val SESSION_ID_BYTES_LENGTH = 16

    /**
     * Constructs the 26-byte AAD binding buffer.
     *
     * @param sessionId 16-byte raw UUID session ID
     * @param blockIndex Source block index (uint32)
     * @param symbolId Symbol identifier or sequence counter (uint32)
     * @param packetTypeCode Packet domain (2 = DATA, 4 = CONTROL, etc.)
     * @param flags Packet header flags (e.g. 0x02 for FLAG_ENCRYPTED)
     * @return Exact 26-byte canonical AAD buffer
     */
    fun buildPacketAad(
        sessionId: ByteArray,
        blockIndex: Long,
        symbolId: Long,
        packetTypeCode: Int = 2,
        flags: Int = 2
    ): ByteArray {
        require(sessionId.size == SESSION_ID_BYTES_LENGTH) {
            "Session ID bytes must be exactly $SESSION_ID_BYTES_LENGTH bytes, got ${sessionId.size}"
        }

        val aad = ByteArray(AAD_LENGTH_BYTES)
        System.arraycopy(sessionId, 0, aad, 0, SESSION_ID_BYTES_LENGTH)

        val buf = ByteBuffer.wrap(aad).order(ByteOrder.BIG_ENDIAN)
        buf.putInt(16, (blockIndex and 0xFFFFFFFFL).toInt())
        buf.putInt(20, (symbolId and 0xFFFFFFFFL).toInt())

        aad[24] = (packetTypeCode and 0xFF).toByte()
        aad[25] = (flags and 0xFF).toByte()

        return aad
    }

    fun buildPacketAad(
        sessionId: ByteArray,
        blockIndex: Int,
        symbolId: Int,
        packetTypeCode: Int = 2,
        flags: Int = 2
    ): ByteArray = buildPacketAad(sessionId, blockIndex.toLong(), symbolId.toLong(), packetTypeCode, flags)
}

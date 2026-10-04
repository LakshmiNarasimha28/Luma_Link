package com.lumalink.harness.crypto

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Manages deterministic 96-bit (12-byte) AEAD nonces for LumaLink sessions.
 *
 * Structure (12 bytes, Big-Endian):
 *   [0]      Domain Tag (1 byte: Bit 7 = direction, Bits 3..0 = packetTypeCode)
 *   [1..3]   Salt Prefix (3 bytes, derived from session master secret)
 *   [4..7]   Block Index (uint32 BE)
 *   [8..11]  Symbol ID / Sequence (uint32 BE)
 *
 * Enforces mathematical disjointness across:
 *   - data messages vs control messages
 *   - sender direction vs receiver direction
 */
object LumaNonce {

    const val NONCE_LENGTH_BYTES = 12
    const val SALT_PREFIX_LENGTH_BYTES = 3

    /**
     * Builds the 1-byte domain tag encoding direction and packet type code.
     * Bit 7: Direction (0 = sender, 1 = receiver)
     * Bits 6..4: Reserved (0)
     * Bits 3..0: Packet Type Code (1=manifest, 2=data, 3=sync, 4=control)
     */
    fun buildDomainTag(direction: String, packetTypeCode: Int): Byte {
        val dirBit = if (direction.equals("receiver", ignoreCase = true)) 0x80 else 0x00
        return (dirBit or (packetTypeCode and 0x0F)).toByte()
    }

    /**
     * Constructs a 12-byte nonce from components.
     *
     * @param saltPrefix 3-byte salt prefix from SessionKeys
     * @param blockIndex Source block index (uint32)
     * @param symbolId Symbol identifier or sequence counter (uint32)
     * @param packetTypeCode Packet domain (2 = DATA, 4 = CONTROL, etc.)
     * @param direction Message flow direction ("sender" or "receiver")
     * @return Exact 12-byte canonical nonce
     */
    fun buildNonce(
        saltPrefix: ByteArray,
        blockIndex: Long,
        symbolId: Long,
        packetTypeCode: Int = 2,
        direction: String = "sender"
    ): ByteArray {
        require(saltPrefix.size == SALT_PREFIX_LENGTH_BYTES) {
            "Salt prefix must be exactly $SALT_PREFIX_LENGTH_BYTES bytes, got ${saltPrefix.size}"
        }

        val nonce = ByteArray(NONCE_LENGTH_BYTES)
        nonce[0] = buildDomainTag(direction, packetTypeCode)
        System.arraycopy(saltPrefix, 0, nonce, 1, SALT_PREFIX_LENGTH_BYTES)

        val buf = ByteBuffer.wrap(nonce).order(ByteOrder.BIG_ENDIAN)
        buf.putInt(4, (blockIndex and 0xFFFFFFFFL).toInt())
        buf.putInt(8, (symbolId and 0xFFFFFFFFL).toInt())

        return nonce
    }

    fun buildNonce(
        saltPrefix: ByteArray,
        blockIndex: Int,
        symbolId: Int,
        packetTypeCode: Int = 2,
        direction: String = "sender"
    ): ByteArray = buildNonce(saltPrefix, blockIndex.toLong(), symbolId.toLong(), packetTypeCode, direction)
}

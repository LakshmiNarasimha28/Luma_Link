package com.lumalink.harness.fec

import com.lumalink.harness.LumaPacketCodec
import com.lumalink.harness.crypto.LumaSecurityContext
import com.lumalink.harness.crypto.TestFixtureSessions

/**
 * TEST-ONLY Cryptographic & LT Packet Integration Fixture.
 *
 * Exclusively for test execution.
 * Prepares deterministic K=16, symbolSize=64 source block (1024 bytes),
 * encodes LT symbols canonically, encrypts them under the Phase 5C.2 golden session,
 * and packages them into 122-byte wire packets with valid CRC32.
 */
object LtPacketIntegrationFixture {

    const val K: Int = 16
    const val SYMBOL_SIZE: Int = 64
    const val TOTAL_SOURCE_BYTES: Int = K * SYMBOL_SIZE // 1024 bytes

    /**
     * Deterministic 1024-byte source payload for K=16 block 0.
     */
    val TEST_SOURCE_DATA: ByteArray by lazy {
        ByteArray(TOTAL_SOURCE_BYTES) { i -> (((i + 1) * 7) and 0xFF).toByte() }
    }

    /**
     * Partitions the 1024-byte source block into 16 source symbols of 64 bytes each.
     */
    val SOURCE_SYMBOLS: List<ByteArray> by lazy {
        List(K) { i ->
            TEST_SOURCE_DATA.copyOfRange(i * SYMBOL_SIZE, (i + 1) * SYMBOL_SIZE)
        }
    }

    /**
     * Generates an unencrypted encoded symbol for block 0 and the given symbolId.
     */
    fun generateSymbolData(symbolId: Long): Pair<Int, ByteArray> {
        val (degree, neighbors) = LtFountainMath.deriveSymbolNeighbors(K, 0L, symbolId)
        val symData = ByteArray(SYMBOL_SIZE)
        for (n in neighbors) {
            val src = SOURCE_SYMBOLS[n]
            for (b in 0 until SYMBOL_SIZE) {
                symData[b] = (symData[b].toInt() xor src[b].toInt()).toByte()
            }
        }
        return Pair(degree, symData)
    }

    /**
     * Generates a single valid 122-byte wire packet authenticated under the golden session.
     */
    fun createGoldenWirePacket(
        symbolId: Long,
        securityContext: LumaSecurityContext = TestFixtureSessions.createGoldenSecurityContext()
    ): ByteArray {
        val (degree, symData) = generateSymbolData(symbolId)

        // Encrypt to wire format [TAG (16B) || CIPHERTEXT (64B)] = 80B
        val wirePayload = securityContext.encryptToWirePayload(
            blockIndex = 0L,
            symbolId = symbolId,
            plaintext = symData,
            packetTypeCode = LumaPacketCodec.TYPE_DATA,
            flags = LumaPacketCodec.FLAG_ENCRYPTED,
            direction = "sender"
        )

        // Encode to 122-byte wire packet with header and CRC32
        return LumaPacketCodec.encode(
            packetType = LumaPacketCodec.TYPE_DATA,
            flags = LumaPacketCodec.FLAG_ENCRYPTED,
            sessionId = TestFixtureSessions.GOLDEN_SESSION_ID_BYTES,
            blockIndex = 0L,
            symbolId = symbolId,
            k = K,
            degree = degree,
            payload = wirePayload
        )
    }

    /**
     * Generates a sequence of [count] valid authenticated wire packets (symbolId 0 until count).
     * 20 symbols are sufficient for 100% reconstruction of the K=16 source block.
     */
    fun createGoldenWirePacketSequence(count: Int = 20): List<ByteArray> {
        val securityContext = TestFixtureSessions.createGoldenSecurityContext()
        return (0 until count).map { symbolId ->
            createGoldenWirePacket(symbolId.toLong(), securityContext)
        }
    }
}

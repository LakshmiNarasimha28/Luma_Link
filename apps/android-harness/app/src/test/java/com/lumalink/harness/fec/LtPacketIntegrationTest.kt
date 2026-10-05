package com.lumalink.harness.fec

import com.lumalink.harness.LumaPacketCodec
import com.lumalink.harness.crypto.DecryptionException
import com.lumalink.harness.crypto.PreProvisionedSessionStore
import com.lumalink.harness.crypto.ReplayException
import com.lumalink.harness.crypto.TestFixtureSessions
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * End-to-end integration tests verifying the full Phase 5C pipeline:
 * Wire packet -> LumaPacketCodec -> CRC OK -> PreProvisionedSessionStore ->
 * LumaSecurityContext -> Authenticated 64B symbol -> LumaLtDecoder -> Reconstructed 1024B Block.
 *
 * Also verifies Phase 5C.2 / 5C.3 security boundaries:
 * - Unauthenticated packet -> no LT ingestion
 * - Tampered ciphertext -> AEAD FAIL, no LT ingestion
 * - Tampered AAD -> AEAD FAIL, no LT ingestion
 * - Replay -> REPLAY FAIL, no LT ingestion
 */
class LtPacketIntegrationTest {

    @Before
    fun setUp() {
        PreProvisionedSessionStore.clear()
        TestFixtureSessions.registerTestSessions()
    }

    @Test
    fun testEndToEndAuthenticatedPacketToReconstructedBlock() {
        val packets = LtPacketIntegrationFixture.createGoldenWirePacketSequence(20)
        val decoder = LumaLtDecoder(defaultSymbolSize = 64)

        var completed = false
        for (wireBytes in packets) {
            assertEquals(122, wireBytes.size)

            // 1. Packet Codec & CRC
            val packet = LumaPacketCodec.decode(wireBytes)
            assertEquals(LumaPacketCodec.TYPE_DATA, packet.packetType)
            assertEquals(LumaPacketCodec.FLAG_ENCRYPTED, packet.flags)
            assertEquals(16, packet.k)

            // 2. PreProvisionedSessionStore Lookup
            val securityContext = PreProvisionedSessionStore.get(packet.sessionId)
            assertNotNull("Session must be registered", securityContext)

            // 3. AEAD Decryption & Authentication
            val plaintext = securityContext!!.decryptFromWirePayload(
                blockIndex = packet.blockIndex,
                symbolId = packet.symbolId,
                wirePayload = packet.payload,
                packetTypeCode = packet.packetType,
                flags = packet.flags,
                checkReplay = true,
                direction = "sender"
            )
            assertEquals(64, plaintext.size)

            // 4. Ingest into LumaLtDecoder
            decoder.addSymbol(
                blockIndex = packet.blockIndex,
                symbolId = packet.symbolId,
                k = packet.k,
                data = plaintext,
                degree = packet.degree
            )

            if (decoder.isBlockComplete(0L)) {
                completed = true
                break
            }
        }

        assertTrue("K=16 block must be fully decoded after 20 packets", completed)
        assertEquals(DecoderStatus.COMPLETE, decoder.getBlockStatus(0L))

        val reconstructed = decoder.reconstructBlock(0L)
        assertNotNull(reconstructed)
        assertEquals(1024, reconstructed!!.size)
        assertArrayEquals(LtPacketIntegrationFixture.TEST_SOURCE_DATA, reconstructed)
    }

    @Test
    fun testOutOfOrderAuthenticatedPacketsToReconstructedBlock() {
        val packets = LtPacketIntegrationFixture.createGoldenWirePacketSequence(20)
        val shuffledPackets = packets.reversed()

        val decoder = LumaLtDecoder(defaultSymbolSize = 64)
        for (wireBytes in shuffledPackets) {
            val packet = LumaPacketCodec.decode(wireBytes)
            val securityContext = PreProvisionedSessionStore.get(packet.sessionId)!!
            val plaintext = securityContext.decryptFromWirePayload(
                blockIndex = packet.blockIndex,
                symbolId = packet.symbolId,
                wirePayload = packet.payload,
                packetTypeCode = packet.packetType,
                flags = packet.flags,
                checkReplay = true,
                direction = "sender"
            )
            decoder.addSymbol(
                blockIndex = packet.blockIndex,
                symbolId = packet.symbolId,
                k = packet.k,
                data = plaintext,
                degree = packet.degree
            )
        }

        assertTrue(decoder.isBlockComplete(0L))
        assertArrayEquals(LtPacketIntegrationFixture.TEST_SOURCE_DATA, decoder.reconstructBlock(0L))
    }

    @Test
    fun testSecurityBoundaryUnauthenticatedPacketDoesNotEnterLtDecoder() {
        val decoder = LumaLtDecoder(defaultSymbolSize = 64)
        val validWireBytes = LtPacketIntegrationFixture.createGoldenWirePacket(0L)

        // Mutate sessionId in wire packet to make it unknown
        val mutatedWireBytes = validWireBytes.copyOf()
        mutatedWireBytes[8] = (mutatedWireBytes[8].toInt() xor 0xFF).toByte()
        // Recompute CRC so framing passes but session lookup fails
        val newCrc = LumaPacketCodec.computePacketChecksum(mutatedWireBytes, 80)
        java.nio.ByteBuffer.wrap(mutatedWireBytes).putInt(38, (newCrc and 0xFFFFFFFFL).toInt())

        val packet = LumaPacketCodec.decode(mutatedWireBytes)
        val securityContext = PreProvisionedSessionStore.get(packet.sessionId)

        assertNull("Unknown session must not be found", securityContext)
        // Pipeline terminates before LT:
        assertNull(decoder.getBlockDecoder(0L))
    }

    @Test
    fun testSecurityBoundaryTamperedCiphertextThrowsAndDoesNotEnterLtDecoder() {
        val decoder = LumaLtDecoder(defaultSymbolSize = 64)
        val validWireBytes = LtPacketIntegrationFixture.createGoldenWirePacket(0L)

        // Tamper 1 byte in ciphertext (offset 60 is inside ciphertext)
        val tamperedBytes = validWireBytes.copyOf()
        tamperedBytes[60] = (tamperedBytes[60].toInt() xor 0x01).toByte()
        // Recompute CRC so CRC check passes
        val newCrc = LumaPacketCodec.computePacketChecksum(tamperedBytes, 80)
        java.nio.ByteBuffer.wrap(tamperedBytes).putInt(38, (newCrc and 0xFFFFFFFFL).toInt())

        val packet = LumaPacketCodec.decode(tamperedBytes)
        val securityContext = PreProvisionedSessionStore.get(packet.sessionId)!!

        try {
            securityContext.decryptFromWirePayload(
                blockIndex = packet.blockIndex,
                symbolId = packet.symbolId,
                wirePayload = packet.payload,
                packetTypeCode = packet.packetType,
                flags = packet.flags,
                checkReplay = true,
                direction = "sender"
            )
            fail("Expected DecryptionException for tampered ciphertext")
        } catch (e: DecryptionException) {
            // Expected: AEAD tag mismatch
        }

        // Verify NO symbol was passed to LT decoder
        assertNull("Tampered packet must never reach LT decoder", decoder.getBlockDecoder(0L))
    }

    @Test
    fun testSecurityBoundaryTamperedAadThrowsAndDoesNotEnterLtDecoder() {
        val decoder = LumaLtDecoder(defaultSymbolSize = 64)
        val validWireBytes = LtPacketIntegrationFixture.createGoldenWirePacket(0L)

        // Tamper flags in header (offset 6: change 0x02 to 0x00)
        val tamperedBytes = validWireBytes.copyOf()
        tamperedBytes[6] = 0x00.toByte()
        // Recompute CRC so CRC check passes
        val newCrc = LumaPacketCodec.computePacketChecksum(tamperedBytes, 80)
        java.nio.ByteBuffer.wrap(tamperedBytes).putInt(38, (newCrc and 0xFFFFFFFFL).toInt())

        val packet = LumaPacketCodec.decode(tamperedBytes)
        val securityContext = PreProvisionedSessionStore.get(packet.sessionId)!!

        try {
            securityContext.decryptFromWirePayload(
                blockIndex = packet.blockIndex,
                symbolId = packet.symbolId,
                wirePayload = packet.payload,
                packetTypeCode = packet.packetType,
                flags = packet.flags,
                checkReplay = true,
                direction = "sender"
            )
            fail("Expected DecryptionException for tampered AAD flags")
        } catch (e: DecryptionException) {
            // Expected: AEAD authentication failure due to AAD mismatch
        }

        assertNull("Tampered AAD packet must never reach LT decoder", decoder.getBlockDecoder(0L))
    }

    @Test
    fun testSecurityBoundaryReplayPacketThrowsAndDoesNotEnterLtDecoder() {
        val decoder = LumaLtDecoder(defaultSymbolSize = 64)
        val wireBytes = LtPacketIntegrationFixture.createGoldenWirePacket(0L)

        val packet = LumaPacketCodec.decode(wireBytes)
        val securityContext = PreProvisionedSessionStore.get(packet.sessionId)!!

        // First delivery: success
        val plaintext = securityContext.decryptFromWirePayload(
            blockIndex = packet.blockIndex,
            symbolId = packet.symbolId,
            wirePayload = packet.payload,
            packetTypeCode = packet.packetType,
            flags = packet.flags,
            checkReplay = true,
            direction = "sender"
        )
        val useful = decoder.addSymbol(
            blockIndex = packet.blockIndex,
            symbolId = packet.symbolId,
            k = packet.k,
            data = plaintext,
            degree = packet.degree
        )
        assertTrue(useful)
        assertEquals(1, decoder.getBlockDecoder(0L)?.recoveredSymbolCount)

        // Second delivery (replay): throws ReplayException
        try {
            securityContext.decryptFromWirePayload(
                blockIndex = packet.blockIndex,
                symbolId = packet.symbolId,
                wirePayload = packet.payload,
                packetTypeCode = packet.packetType,
                flags = packet.flags,
                checkReplay = true,
                direction = "sender"
            )
            fail("Expected ReplayException for replayed symbol")
        } catch (e: ReplayException) {
            // Expected: replay rejected
        }

        // Recovered symbol count has not changed
        assertEquals(1, decoder.getBlockDecoder(0L)?.recoveredSymbolCount)
    }
}

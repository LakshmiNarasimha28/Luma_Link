package com.lumalink.harness.transfer

import com.lumalink.harness.LumaPacketCodec
import com.lumalink.harness.crypto.DecryptionException
import com.lumalink.harness.crypto.LumaSecurityContext
import com.lumalink.harness.crypto.TestFixtureSessions
import com.lumalink.harness.fec.LtFountainMath
import com.lumalink.harness.fec.LtPacketIntegrationFixture
import com.lumalink.harness.fec.LumaLtDecoder
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * Headless end-to-end integration test verifying the complete receiver path:
 *
 * Wire TransportPacket (122 bytes)
 *   ↓
 * LumaPacketCodec (CRC-32 + framing)
 *   ↓
 * Session-bound security context lookup
 *   ↓
 * ChaCha20-Poly1305 AEAD decryption
 *   ↓
 * LumaLtDecoder (Luby Transform peeling graph)
 *   ↓
 * LumaFileReassembler (Block ordering + padding trimming)
 *   ↓
 * PlatformHasher (SHA-256 verification)
 *   ↓
 * ReassemblyResult [verifiedSha256 = true]
 */
class ReassemblyPacketIntegrationTest {

    private val sessionId = TestFixtureSessions.GOLDEN_SESSION_ID_BYTES

    @Before
    fun setUp() {
        PreProvisionedManifestStore.clear()
        TestFixtureSessions.registerTestSessions()
    }

    @Test
    fun testEndToEndSingleBlockPipeline() {
        val securityContext = TestFixtureSessions.createGoldenSecurityContext()
        val decoder = LumaLtDecoder(defaultSymbolSize = LtPacketIntegrationFixture.SYMBOL_SIZE)

        // Session-bound manifest lookup
        val manifest = PreProvisionedManifestStore.get(sessionId)
        assertNotNull("Manifest must be bound to authenticated sessionId", manifest)
        val reassembler = LumaFileReassembler(manifest!!)

        // Generate 20 authenticated wire packets (sufficient for K=16 peeling recovery)
        val wirePackets = LtPacketIntegrationFixture.createGoldenWirePacketSequence(20)

        var completedBlockData: ByteArray? = null
        val completedBlocks = mutableSetOf<Long>()

        for (wireBytes in wirePackets) {
            // 1. Codec decode & CRC validation
            val packet = LumaPacketCodec.decode(wireBytes)

            // 2. AEAD Decryption
            val plaintext = securityContext.decryptFromWirePayload(
                blockIndex = packet.blockIndex,
                symbolId = packet.symbolId,
                wirePayload = packet.payload,
                packetTypeCode = packet.packetType,
                flags = packet.flags,
                checkReplay = true,
                direction = "sender"
            )

            // 3. LT Decoder ingestion
            decoder.addSymbol(
                blockIndex = packet.blockIndex,
                symbolId = packet.symbolId,
                k = packet.k,
                data = plaintext,
                degree = packet.degree
            )

            // 4. Completed block check (idempotent, prevents re-adding)
            if (decoder.isBlockComplete(packet.blockIndex) && !completedBlocks.contains(packet.blockIndex)) {
                val blockBytes = decoder.reconstructBlock(packet.blockIndex)
                assertNotNull(blockBytes)
                reassembler.addBlock(packet.blockIndex, blockBytes!!)
                completedBlocks.add(packet.blockIndex)
                completedBlockData = blockBytes
            }
        }

        // Verify block recovery
        assertTrue(decoder.isBlockComplete(0L))
        assertNotNull(completedBlockData)
        assertEquals(1024, completedBlockData!!.size)

        // Verify file reassembly and SHA-256 verification
        assertTrue(reassembler.isComplete())
        val result = reassembler.reassemble()

        assertTrue(result.success)
        assertTrue(result.verifiedSha256)
        assertEquals(1024, result.fileBytes.size)
        assertEquals("6d08077b4795f29ba27c3f7802ba28d26bf8cc55f8b60e6081bbda4e15c7760f", result.sha256Digest)
        assertArrayEquals(LtPacketIntegrationFixture.TEST_SOURCE_DATA, result.fileBytes)
    }

    @Test
    fun testEndToEndMultiBlockPipelineWithInterleavedArrival() {
        val securityContext = TestFixtureSessions.createGoldenSecurityContext()
        val decoder = LumaLtDecoder(defaultSymbolSize = 64)

        // 2-block file: 1800 bytes (Block 0: 1024 bytes, Block 1: 776 bytes + 248 bytes zero padding)
        val k = 16
        val symbolSize = 64
        val rawBlockSize = k * symbolSize // 1024 bytes
        val fileSize = 1800L
        val fullFile = ByteArray(fileSize.toInt()) { i -> ((i * 17 + 23) and 0xFF).toByte() }

        val hasher = PlatformHasher()
        val expectedSha256 = hasher.hashSha256(fullFile)

        val multiBlockManifest = LumaFileManifest(
            sessionId = sessionId,
            fileName = "multi-1800.bin",
            fileSize = fileSize,
            sha256Digest = expectedSha256,
            symbolSize = symbolSize,
            symbolsPerBlock = k,
            totalBlocks = 2
        )
        PreProvisionedManifestStore.register(sessionId, multiBlockManifest)

        // Prepare source symbols for Block 0 (1024 bytes)
        val block0Source = fullFile.copyOfRange(0, 1024)
        val block0Symbols = List(k) { i -> block0Source.copyOfRange(i * symbolSize, (i + 1) * symbolSize) }

        // Prepare source symbols for Block 1 (776 bytes + 248 bytes zero padding = 1024 bytes)
        val block1Source = ByteArray(rawBlockSize)
        System.arraycopy(fullFile, 1024, block1Source, 0, 776)
        val block1Symbols = List(k) { i -> block1Source.copyOfRange(i * symbolSize, (i + 1) * symbolSize) }

        fun createPacket(blockIndex: Long, symbolId: Long, sourceSymbols: List<ByteArray>): ByteArray {
            val (degree, neighbors) = LtFountainMath.deriveSymbolNeighbors(k, blockIndex, symbolId)
            val symData = ByteArray(symbolSize)
            for (n in neighbors) {
                val src = sourceSymbols[n]
                for (b in 0 until symbolSize) {
                    symData[b] = (symData[b].toInt() xor src[b].toInt()).toByte()
                }
            }
            val wirePayload = securityContext.encryptToWirePayload(
                blockIndex = blockIndex,
                symbolId = symbolId,
                plaintext = symData,
                packetTypeCode = LumaPacketCodec.TYPE_DATA,
                flags = LumaPacketCodec.FLAG_ENCRYPTED,
                direction = "sender"
            )
            return LumaPacketCodec.encode(
                packetType = LumaPacketCodec.TYPE_DATA,
                flags = LumaPacketCodec.FLAG_ENCRYPTED,
                sessionId = sessionId,
                blockIndex = blockIndex,
                symbolId = symbolId,
                k = k,
                degree = degree,
                payload = wirePayload
            )
        }

        // Generate 30 symbols for block 0 and 30 symbols for block 1 (overhead sufficient for K=16 peeling)
        val packetsBlock0 = (0 until 30).map { createPacket(0L, it.toLong(), block0Symbols) }
        val packetsBlock1 = (0 until 30).map { createPacket(1L, it.toLong(), block1Symbols) }

        // Interleave packets from both blocks (simulating interleaved wireless/optical reception)
        val interleaved = mutableListOf<ByteArray>()
        for (i in 0 until 30) {
            if (i % 2 == 0) {
                interleaved.add(packetsBlock1[i])
                interleaved.add(packetsBlock0[i])
            } else {
                interleaved.add(packetsBlock0[i])
                interleaved.add(packetsBlock1[i])
            }
        }

        val reassembler = LumaFileReassembler(multiBlockManifest)
        val completedBlocks = mutableSetOf<Long>()

        for (wireBytes in interleaved) {
            val packet = LumaPacketCodec.decode(wireBytes)
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

            if (decoder.isBlockComplete(packet.blockIndex) && !completedBlocks.contains(packet.blockIndex)) {
                val blockBytes = decoder.reconstructBlock(packet.blockIndex)
                assertNotNull(blockBytes)
                reassembler.addBlock(packet.blockIndex, blockBytes!!)
                completedBlocks.add(packet.blockIndex)
            }
        }

        assertTrue(reassembler.isComplete())
        val result = reassembler.reassemble()
        assertTrue(result.success)
        assertTrue(result.verifiedSha256)
        assertEquals(1800, result.fileBytes.size)
        assertArrayEquals(fullFile, result.fileBytes)
        assertEquals(expectedSha256, result.sha256Digest)
    }

    @Test
    fun testCorruptedCiphertextFailsAtAeadBoundary() {
        val securityContext = TestFixtureSessions.createGoldenSecurityContext()
        val validWire = LtPacketIntegrationFixture.createGoldenWirePacket(0L, securityContext)

        // Corrupt ciphertext byte in payload (payload starts at index 42)
        val tamperedWire = validWire.copyOf()
        tamperedWire[60] = (tamperedWire[60].toInt() xor 0xFF).toByte()
        // Recompute CRC so it passes CRC validation to reach crypto layer
        val badPacket = LumaPacketCodec.decode(
            LumaPacketCodec.encode(
                packetType = LumaPacketCodec.TYPE_DATA,
                flags = LumaPacketCodec.FLAG_ENCRYPTED,
                sessionId = sessionId,
                blockIndex = 0L,
                symbolId = 0L,
                k = 16,
                degree = 1,
                payload = tamperedWire.copyOfRange(42, tamperedWire.size)
            )
        )

        try {
            securityContext.decryptFromWirePayload(
                blockIndex = badPacket.blockIndex,
                symbolId = badPacket.symbolId,
                wirePayload = badPacket.payload,
                packetTypeCode = badPacket.packetType,
                flags = badPacket.flags,
                checkReplay = true,
                direction = "sender"
            )
            fail("Expected DecryptionException on tampered ciphertext")
        } catch (e: DecryptionException) {
            // Expected: fails at AEAD boundary before reaching LT or reassembler
        }
    }

    @Test
    fun testUnknownSessionFailsClosed() {
        val unknownSessionId = ByteArray(16) { 0x55.toByte() }
        val manifest = PreProvisionedManifestStore.get(unknownSessionId)
        assertNull("Unknown session must fail closed with null manifest", manifest)
    }
}

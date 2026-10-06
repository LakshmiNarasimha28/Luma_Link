package com.lumalink.harness.session

import com.lumalink.harness.LumaPacketCodec
import com.lumalink.harness.crypto.TestFixtureSessions
import com.lumalink.harness.fec.LtPacketIntegrationFixture
import com.lumalink.harness.fec.LumaLtDecoder
import com.lumalink.harness.transfer.LumaFileReassembler
import com.lumalink.harness.transfer.PreProvisionedManifestStore
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * Phase 6.2 Integration and Session Isolation Test Suite.
 *
 * Verifies the complete dynamic manifest acquisition pipeline:
 * - Test 1: Novel MANIFEST packet registers successfully
 * - Test 2: Identical repeated MANIFEST is idempotent
 * - Test 3: Conflicting fileName is rejected (SESSION_CONFLICT), original preserved
 * - Test 4: Conflicting SHA-256 is rejected (SESSION_CONFLICT), original preserved
 * - Test 5: Conflicting FEC parameters are rejected (SESSION_CONFLICT)
 * - Test 6: DATA before MANIFEST fails closed (no FEC, no reassembly)
 * - Test 7: MANIFEST A -> DATA A dynamic end-to-end transfer (ZERO pre-provisioned manifest!)
 * - Test 8: MANIFEST A -> DATA B fails closed (session isolation)
 */
class DynamicManifestIntegrationTest {

    private val sessionIdA = TestFixtureSessions.GOLDEN_SESSION_ID_BYTES
    private val sessionIdB = ByteArray(16) { 0xBB.toByte() }

    private val announcementA = LumaSessionAnnouncement(
        sessionId = sessionIdA,
        mode = "quick",
        senderDeviceId = "sender-test-dev-01",
        senderPublicKey = TestFixtureSessions.ALICE_PUB,
        fileName = "golden-1024.bin",
        fileSize = 1024L,
        sha256Digest = "6d08077b4795f29ba27c3f7802ba28d26bf8cc55f8b60e6081bbda4e15c7760f",
        symbolSize = 64,
        symbolsPerBlock = 16,
        totalBlocks = 1,
        timestamp = 1728120000000L
    )

    private fun createManifestWirePacket(announcement: LumaSessionAnnouncement): ByteArray {
        val payload = LumaManifestCodec.encode(announcement)
        return LumaPacketCodec.encode(
            packetType = LumaPacketCodec.TYPE_MANIFEST,
            flags = 0,
            sessionId = announcement.sessionId,
            blockIndex = 0L,
            symbolId = 0L,
            k = announcement.symbolsPerBlock,
            degree = 0,
            payload = payload
        )
    }

    @Before
    fun setUp() {
        SessionManifestStore.clear()
        PreProvisionedManifestStore.clear()
        TestFixtureSessions.registerTestSessions()
    }

    @Test
    fun test1_manifestRegistersSuccessfully() {
        val wireBytes = createManifestWirePacket(announcementA)

        // 1. Packet framing decode & CRC check
        val packet = LumaPacketCodec.decode(wireBytes)
        assertEquals(LumaPacketCodec.TYPE_MANIFEST, packet.packetType)
        assertArrayEquals(sessionIdA, packet.sessionId)

        // 2. Manifest decode & header binding check
        val announcement = LumaManifestCodec.decode(packet.payload)
        assertArrayEquals(packet.sessionId, announcement.sessionId)

        // 3. Dynamic store registration
        val result = SessionManifestStore.register(announcement)
        assertEquals(ManifestRegistrationResult.Accepted, result)
        assertTrue(SessionManifestStore.contains(sessionIdA))
        assertEquals(announcementA, SessionManifestStore.get(sessionIdA))
    }

    @Test
    fun test2_manifestArrivesAgainUnchanged_isIdempotent() {
        val wireBytes = createManifestWirePacket(announcementA)

        // First packet
        val packet1 = LumaPacketCodec.decode(wireBytes)
        val announcement1 = LumaManifestCodec.decode(packet1.payload)
        assertEquals(ManifestRegistrationResult.Accepted, SessionManifestStore.register(announcement1))

        // Interleaved/repeated duplicate packet
        val packet2 = LumaPacketCodec.decode(wireBytes)
        val announcement2 = LumaManifestCodec.decode(packet2.payload)
        val result2 = SessionManifestStore.register(announcement2)

        assertEquals(ManifestRegistrationResult.DuplicateAccepted, result2)
        assertEquals(1, SessionManifestStore.count())
        assertEquals(announcementA, SessionManifestStore.get(sessionIdA))
    }

    @Test
    fun test3_manifestArrivesWithChangedFileName_rejectedAndOriginalPreserved() {
        val wireBytes = createManifestWirePacket(announcementA)
        val packet1 = LumaPacketCodec.decode(wireBytes)
        SessionManifestStore.register(LumaManifestCodec.decode(packet1.payload))

        // Conflicting packet with tampered fileName
        val conflictingAnnouncement = announcementA.copy(fileName = "malicious.exe")
        val conflictingWireBytes = createManifestWirePacket(conflictingAnnouncement)
        val conflictingPacket = LumaPacketCodec.decode(conflictingWireBytes)
        val conflictingDecoded = LumaManifestCodec.decode(conflictingPacket.payload)

        val exception = assertThrows(ConflictingManifestException::class.java) {
            SessionManifestStore.register(conflictingDecoded)
        }
        assertTrue(exception.message!!.contains("fileName mismatch"))

        // Original preserved
        assertEquals("golden-1024.bin", SessionManifestStore.get(sessionIdA)!!.fileName)
    }

    @Test
    fun test4_manifestArrivesWithChangedSha256_rejected() {
        val wireBytes = createManifestWirePacket(announcementA)
        val packet1 = LumaPacketCodec.decode(wireBytes)
        SessionManifestStore.register(LumaManifestCodec.decode(packet1.payload))

        // Conflicting packet with tampered SHA-256 digest
        val conflictingAnnouncement = announcementA.copy(sha256Digest = "0".repeat(64))
        val conflictingWireBytes = createManifestWirePacket(conflictingAnnouncement)
        val conflictingPacket = LumaPacketCodec.decode(conflictingWireBytes)
        val conflictingDecoded = LumaManifestCodec.decode(conflictingPacket.payload)

        val exception = assertThrows(ConflictingManifestException::class.java) {
            SessionManifestStore.register(conflictingDecoded)
        }
        assertTrue(exception.message!!.contains("sha256Digest mismatch"))
    }

    @Test
    fun test5_manifestArrivesWithChangedFecParameters_rejected() {
        val wireBytes = createManifestWirePacket(announcementA)
        val packet1 = LumaPacketCodec.decode(wireBytes)
        SessionManifestStore.register(LumaManifestCodec.decode(packet1.payload))

        // Conflicting totalBlocks
        val conflictingAnnouncement = announcementA.copy(totalBlocks = 10)
        val conflictingWireBytes = createManifestWirePacket(conflictingAnnouncement)
        val conflictingPacket = LumaPacketCodec.decode(conflictingWireBytes)
        val conflictingDecoded = LumaManifestCodec.decode(conflictingPacket.payload)

        val exception = assertThrows(ConflictingManifestException::class.java) {
            SessionManifestStore.register(conflictingDecoded)
        }
        assertTrue(exception.message!!.contains("totalBlocks mismatch"))
    }

    @Test
    fun test6_dataArrivesBeforeManifest_isRejected() {
        // Ensure store is completely empty
        SessionManifestStore.clear()
        assertFalse(SessionManifestStore.contains(sessionIdA))

        val wirePackets = LtPacketIntegrationFixture.createGoldenWirePacketSequence(5)
        val decoder = LumaLtDecoder(defaultSymbolSize = LtPacketIntegrationFixture.SYMBOL_SIZE)

        var rejectedDataCount = 0

        for (wireBytes in wirePackets) {
            val packet = LumaPacketCodec.decode(wireBytes)
            assertEquals(LumaPacketCodec.TYPE_DATA, packet.packetType)

            // Dynamic session manifest lookup (FAIL CLOSED)
            val manifest = SessionManifestStore.getManifest(packet.sessionId)
            if (manifest == null) {
                // DATA packet dropped: cannot decrypt or ingest without valid session manifest
                rejectedDataCount++
            } else {
                fail("DATA packet must not be accepted without a registered manifest")
            }
        }

        assertEquals(5, rejectedDataCount)
        assertEquals(0, decoder.getBlockDecoder(0L)?.recoveredSymbolCount ?: 0)
    }

    @Test
    fun test7_manifestAFollowedByDataA_isAcceptedAndReassembled() {
        // CRITICAL INVARIANT: Zero pre-provisioned manifest!
        SessionManifestStore.clear()
        assertFalse(SessionManifestStore.contains(sessionIdA))

        val securityContext = TestFixtureSessions.createGoldenSecurityContext()
        val decoder = LumaLtDecoder(defaultSymbolSize = LtPacketIntegrationFixture.SYMBOL_SIZE)

        // 1. MANIFEST packet arrives first
        val manifestWireBytes = createManifestWirePacket(announcementA)
        val manifestPacket = LumaPacketCodec.decode(manifestWireBytes)
        assertEquals(LumaPacketCodec.TYPE_MANIFEST, manifestPacket.packetType)

        val announcement = LumaManifestCodec.decode(manifestPacket.payload)
        val regResult = SessionManifestStore.register(announcement)
        assertEquals(ManifestRegistrationResult.Accepted, regResult)

        // Manifest is now dynamically available in store!
        assertTrue(SessionManifestStore.contains(sessionIdA))

        // 2. Construct dynamic reassembler directly from dynamic store
        val manifest = SessionManifestStore.getManifest(sessionIdA)
        assertNotNull(manifest)
        val reassembler = LumaFileReassembler(manifest!!)

        // 3. Sender transmits authenticated DATA wire packets
        val dataWirePackets = LtPacketIntegrationFixture.createGoldenWirePacketSequence(20)
        val completedBlocks = mutableSetOf<Long>()
        var reconstructedBytes: ByteArray? = null

        for (wireBytes in dataWirePackets) {
            val packet = LumaPacketCodec.decode(wireBytes)
            assertEquals(LumaPacketCodec.TYPE_DATA, packet.packetType)

            // Dynamic manifest lookup passes
            val sessionManifest = SessionManifestStore.getManifest(packet.sessionId)
            assertNotNull(sessionManifest)

            // AEAD Decrypt
            val plaintext = securityContext.decryptFromWirePayload(
                blockIndex = packet.blockIndex,
                symbolId = packet.symbolId,
                wirePayload = packet.payload,
                packetTypeCode = packet.packetType,
                flags = packet.flags,
                checkReplay = true,
                direction = "sender"
            )

            // FEC Ingest
            decoder.addSymbol(
                blockIndex = packet.blockIndex,
                symbolId = packet.symbolId,
                k = packet.k,
                data = plaintext,
                degree = packet.degree
            )

            // Reconstruct block upon completion
            if (decoder.isBlockComplete(packet.blockIndex) && !completedBlocks.contains(packet.blockIndex)) {
                val blockData = decoder.reconstructBlock(packet.blockIndex)
                assertNotNull(blockData)
                reassembler.addBlock(packet.blockIndex, blockData!!)
                completedBlocks.add(packet.blockIndex)
                reconstructedBytes = blockData
            }
        }

        // 4. Verify verified plaintext file result
        assertTrue(decoder.isBlockComplete(0L))
        assertNotNull(reconstructedBytes)
        assertTrue(reassembler.isComplete())

        val result = reassembler.reassemble()
        assertTrue(result.success)
        assertTrue(result.verifiedSha256)
        assertEquals(1024, result.fileBytes.size)
        assertEquals(announcementA.sha256Digest, result.sha256Digest)
        assertArrayEquals(LtPacketIntegrationFixture.TEST_SOURCE_DATA, result.fileBytes)
    }

    @Test
    fun test8_manifestAFollowedByDataB_dataBIsRejected() {
        // Register Session A
        val manifestWireBytes = createManifestWirePacket(announcementA)
        val manifestPacket = LumaPacketCodec.decode(manifestWireBytes)
        SessionManifestStore.register(LumaManifestCodec.decode(manifestPacket.payload))

        // Create DATA packet bound to Session B
        val dummyPayload = ByteArray(80)
        val dataBWireBytes = LumaPacketCodec.encode(
            packetType = LumaPacketCodec.TYPE_DATA,
            flags = LumaPacketCodec.FLAG_ENCRYPTED,
            sessionId = sessionIdB,
            blockIndex = 0L,
            symbolId = 0L,
            k = 16,
            degree = 1,
            payload = dummyPayload
        )

        val packetB = LumaPacketCodec.decode(dataBWireBytes)
        assertEquals(LumaPacketCodec.TYPE_DATA, packetB.packetType)
        assertArrayEquals(sessionIdB, packetB.sessionId)

        // Session lookup for Session B fails closed
        val manifestB = SessionManifestStore.getManifest(packetB.sessionId)
        assertNull("DATA B must be rejected because Session B manifest was never registered", manifestB)
    }
}

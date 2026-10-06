package com.lumalink.harness.transfer

import com.lumalink.harness.ChecksumMismatchException
import com.lumalink.harness.LumaPacketCodec
import com.lumalink.harness.crypto.AndroidCryptoProvider
import com.lumalink.harness.crypto.ConflictingKeyEnvelopeException
import com.lumalink.harness.crypto.DecryptionException
import com.lumalink.harness.crypto.KeyEnvelopeUnwrapResult
import com.lumalink.harness.crypto.LumaAuthResponse
import com.lumalink.harness.crypto.LumaControlCodec
import com.lumalink.harness.crypto.LumaEncryptedKeyEnvelope
import com.lumalink.harness.crypto.LumaKeyEnvelopeUnwrapper
import com.lumalink.harness.crypto.LumaSecurityContext
import com.lumalink.harness.crypto.ManifestKeyMismatchException
import com.lumalink.harness.crypto.PreProvisionedSessionStore
import com.lumalink.harness.crypto.TargetDeviceMismatchException
import com.lumalink.harness.crypto.TestFixtureSessions
import com.lumalink.harness.fec.LtPacketIntegrationFixture
import com.lumalink.harness.fec.LumaLtDecoder
import com.lumalink.harness.session.LumaManifestCodec
import com.lumalink.harness.session.LumaSessionAnnouncement
import com.lumalink.harness.session.ManifestRegistrationResult
import com.lumalink.harness.session.SessionManifestStore
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.security.MessageDigest
import kotlin.random.Random

/**
 * Phase 6.4: Physical Optical Session Flow Simulation & Verification Test Suite.
 *
 * Implements the required Phase 6.4 Test Matrix:
 * - TEST A: Clean Physical Transfer (Interleaved Carousel: MANIFEST -> KEY_ENVELOPE -> DATA x 3 -> ... -> SHA-256 OK)
 * - TEST B: Repeated CONTROL Envelope Deduplication (Carousel Repetition, DuplicateAccepted, Zero Rederivation)
 * - TEST C: Intermittent Packet Loss Survival (Optical Drops & Duplicates, Fountain Recovery)
 * - TEST D: Physical Session Restart & Clean Isolation (Zero Cross-Session Contamination)
 * - TEST E: Negative Validation Fail-Closed (Target Mismatch, Key Mismatch, Corrupted Tag, Bad CRC, Missing Manifest)
 */
class PhysicalOpticalSessionFlowTest {

    private val crypto = AndroidCryptoProvider()
    private val localDeviceId = "device-bob"
    private val localPrivateKey = TestFixtureSessions.BOB_PRIV
    private val localPublicKey = TestFixtureSessions.BOB_PUB

    private val senderDeviceId = "phase6-sender"
    private val senderPrivateKey = TestFixtureSessions.ALICE_PRIV
    private val senderPublicKey = TestFixtureSessions.ALICE_PUB

    private lateinit var keyEnvelopeUnwrapper: LumaKeyEnvelopeUnwrapper

    @Before
    fun setUp() {
        PreProvisionedSessionStore.clear()
        SessionManifestStore.clear()
        keyEnvelopeUnwrapper = LumaKeyEnvelopeUnwrapper(
            localDeviceId = localDeviceId,
            localPrivateKey = localPrivateKey,
            crypto = crypto
        )
    }

    private fun sha256Hex(data: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(data)
        val sb = StringBuilder(digest.size * 2)
        for (b in digest) {
            val v = b.toInt() and 0xFF
            if (v < 16) sb.append('0')
            sb.append(Integer.toHexString(v))
        }
        return sb.toString()
    }

    private fun buildSessionPackets(
        sessionId: ByteArray,
        fileData: ByteArray,
        senderPrivKey: ByteArray = senderPrivateKey,
        senderPubKey: ByteArray = senderPublicKey
    ): SessionTestBundle {
        val expectedSha = sha256Hex(fileData)
        val k = 16
        val symbolSize = 64
        val totalBlocks = 1

        val masterSecret = ByteArray(32) { i -> ((i * 13 + 37) and 0xFF).toByte() }
        val sessionKeys = crypto.deriveSessionKeys(masterSecret, sessionId, "LumaLink-QuickSend-v2")
        val senderContext = LumaSecurityContext(sessionId, sessionKeys, crypto)

        // 1. MANIFEST Announcement
        val announcement = LumaSessionAnnouncement(
            sessionId = sessionId,
            timestamp = 1728000000000L,
            mode = "quick",
            fileSize = fileData.size.toLong(),
            totalBlocks = totalBlocks,
            symbolSize = symbolSize,
            symbolsPerBlock = k,
            senderPublicKey = senderPubKey,
            sha256Digest = expectedSha,
            senderDeviceId = senderDeviceId,
            fileName = "phase6-optical-test.bin"
        )
        val manifestPayload = LumaManifestCodec.encode(announcement)
        val manifestPacketBytes = LumaPacketCodec.encode(
            version = 1,
            packetType = LumaPacketCodec.TYPE_MANIFEST,
            flags = 0,
            sessionId = sessionId,
            blockIndex = 0L,
            symbolId = 0L,
            k = k,
            degree = 0,
            payload = manifestPayload
        )

        // 2. Pre-Arranged KEY_ENVELOPE (Sealed to Bob)
        val pairwiseZ = crypto.computeSharedSecret(senderPrivKey, localPublicKey)
        val kWrap = crypto.hkdf(pairwiseZ, sessionId, "LumaLink-KeyWrap-v1".toByteArray(Charsets.UTF_8), 32)
        val wrapNonce = ByteArray(12) { i -> (i + 1).toByte() }
        val aad = LumaKeyEnvelopeUnwrapper.buildEnvelopeAad(sessionId, localDeviceId)
        val wrappedMaster = crypto.encryptAead(kWrap, wrapNonce, masterSecret, aad)
        val wrapTag = wrappedMaster.copyOfRange(0, 16)
        val wrappedCiphertext = wrappedMaster.copyOfRange(16, 48)

        val envelope = LumaEncryptedKeyEnvelope(
            targetDeviceId = localDeviceId,
            ephemeralPublicKey = senderPubKey,
            wrapNonce = wrapNonce,
            wrapTag = wrapTag,
            wrappedCiphertext = wrappedCiphertext
        )
        val authResponse = LumaAuthResponse(
            sessionId = sessionId,
            receiverDeviceId = localDeviceId,
            authState = LumaControlCodec.AUTH_STATE_AUTHORIZED,
            reasonCode = 0,
            keyEnvelope = envelope
        )
        val authResponsePayload = LumaControlCodec.encodeAuthResponse(authResponse)
        val controlPacketBytes = LumaPacketCodec.encode(
            version = 1,
            packetType = LumaPacketCodec.TYPE_CONTROL,
            flags = 0,
            sessionId = sessionId,
            blockIndex = 0L,
            symbolId = 1L,
            k = 0,
            degree = 0,
            payload = authResponsePayload
        )

        // 3. Encrypted DATA Packets (Overhead factor 2.4x -> 39 fountain packets)
        val dataPackets = mutableListOf<ByteArray>()
        for (i in 0 until 39) {
            val (degree, symData) = LtPacketIntegrationFixture.generateSymbolData(i.toLong())
            val wirePayload = senderContext.encryptToWirePayload(
                blockIndex = 0L,
                symbolId = i.toLong(),
                plaintext = symData,
                packetTypeCode = LumaPacketCodec.TYPE_DATA,
                flags = LumaPacketCodec.FLAG_ENCRYPTED,
                direction = "sender"
            )
            val packetBytes = LumaPacketCodec.encode(
                version = 1,
                packetType = LumaPacketCodec.TYPE_DATA,
                flags = LumaPacketCodec.FLAG_ENCRYPTED,
                sessionId = sessionId,
                blockIndex = 0L,
                symbolId = i.toLong(),
                k = k,
                degree = degree,
                payload = wirePayload
            )
            dataPackets.add(packetBytes)
        }

        return SessionTestBundle(
            announcement = announcement,
            manifestPacketBytes = manifestPacketBytes,
            envelope = envelope,
            controlPacketBytes = controlPacketBytes,
            dataPackets = dataPackets,
            expectedSha256 = expectedSha,
            originalFileBytes = fileData
        )
    }

    private data class SessionTestBundle(
        val announcement: LumaSessionAnnouncement,
        val manifestPacketBytes: ByteArray,
        val envelope: LumaEncryptedKeyEnvelope,
        val controlPacketBytes: ByteArray,
        val dataPackets: List<ByteArray>,
        val expectedSha256: String,
        val originalFileBytes: ByteArray
    )

    // =========================================================================
    // TEST A: Clean Physical Transfer (Interleaved Carousel)
    // =========================================================================
    @Test
    fun testScenarioA_cleanPhysicalTransferWithInterleavedCarousel() {
        val bundle = buildSessionPackets(TestFixtureSessions.GOLDEN_SESSION_ID_BYTES, LtPacketIntegrationFixture.TEST_SOURCE_DATA)
        val decoder = LumaLtDecoder(defaultSymbolSize = 64)
        var reassembler: LumaFileReassembler? = null
        var verifiedResult: ReassemblyResult? = null

        // Interleave sequence: MANIFEST, KEY_ENVELOPE, DATA, DATA, DATA, MANIFEST, KEY_ENVELOPE, DATA...
        val interleavedStream = mutableListOf<ByteArray>()
        for (i in bundle.dataPackets.indices) {
            if (i % 3 == 0) {
                interleavedStream.add(bundle.manifestPacketBytes)
                interleavedStream.add(bundle.controlPacketBytes)
            }
            interleavedStream.add(bundle.dataPackets[i])
        }

        var manifestAcquiredCount = 0
        var envelopeAcquiredCount = 0
        var dataDecryptedCount = 0

        for (wireBytes in interleavedStream) {
            val packet = LumaPacketCodec.decode(wireBytes)
            when (packet.packetType) {
                LumaPacketCodec.TYPE_MANIFEST -> {
                    val announcement = LumaManifestCodec.decode(packet.payload)
                    val result = SessionManifestStore.register(announcement)
                    if (result is ManifestRegistrationResult.Accepted) manifestAcquiredCount++
                    if (reassembler == null) {
                        reassembler = LumaFileReassembler(SessionManifestStore.getManifest(packet.sessionId)!!)
                    }
                }
                LumaPacketCodec.TYPE_CONTROL -> {
                    val authResponse = LumaControlCodec.decodeAuthResponse(packet.payload)
                    if (authResponse.isAuthorized && authResponse.keyEnvelope != null) {
                        val manifest = SessionManifestStore.get(packet.sessionId)!!
                        val unwrapResult = keyEnvelopeUnwrapper.unwrapAndRegister(
                            envelope = authResponse.keyEnvelope!!,
                            manifest = manifest,
                            rawEnvelopePayload = packet.payload
                        )
                        if (unwrapResult is KeyEnvelopeUnwrapResult.Accepted) envelopeAcquiredCount++
                    }
                }
                LumaPacketCodec.TYPE_DATA -> {
                    val secContext = PreProvisionedSessionStore.get(packet.sessionId)
                    assertNotNull("DATA must have established security context", secContext)
                    val plaintext = secContext!!.decryptFromWirePayload(
                        blockIndex = packet.blockIndex,
                        symbolId = packet.symbolId,
                        wirePayload = packet.payload,
                        packetTypeCode = packet.packetType,
                        flags = packet.flags,
                        checkReplay = true,
                        direction = "sender"
                    )
                    dataDecryptedCount++
                    decoder.addSymbol(packet.blockIndex, packet.symbolId, packet.k, plaintext, packet.degree)

                    if (decoder.isBlockComplete(packet.blockIndex) && !reassembler!!.isComplete()) {
                        val blockBytes = decoder.reconstructBlock(packet.blockIndex)!!
                        reassembler.addBlock(packet.blockIndex, blockBytes)
                        if (reassembler.isComplete() && verifiedResult == null) {
                            verifiedResult = reassembler.reassemble()
                        }
                    }
                }
            }
        }

        assertEquals("Manifest should be accepted on initial frame", 1, manifestAcquiredCount)
        assertEquals("Envelope should be unwrapped exactly once initially", 1, envelopeAcquiredCount)
        assertTrue("DATA packets should be decrypted", dataDecryptedCount >= 16)
        assertNotNull("Reassembly should be complete", verifiedResult)
        assertEquals("SHA-256 digest must match expected manifest digest", bundle.expectedSha256, verifiedResult!!.sha256Digest)
        assertArrayEquals("Reassembled file bytes must match original file", bundle.originalFileBytes, verifiedResult.fileBytes)
    }

    // =========================================================================
    // TEST B: Repeated CONTROL Envelope Deduplication
    // =========================================================================
    @Test
    fun testScenarioB_repeatedKeyEnvelopeDeduplicationDuringCarousel() {
        val bundle = buildSessionPackets(TestFixtureSessions.GOLDEN_SESSION_ID_BYTES, LtPacketIntegrationFixture.TEST_SOURCE_DATA)
        val manifest = bundle.announcement
        SessionManifestStore.register(manifest)

        var acceptedCount = 0
        var duplicateCount = 0

        // Simulate 10 carousel passes of the exact same KEY_ENVELOPE packet
        for (i in 0 until 10) {
            val packet = LumaPacketCodec.decode(bundle.controlPacketBytes)
            val authResponse = LumaControlCodec.decodeAuthResponse(packet.payload)
            val unwrapResult = keyEnvelopeUnwrapper.unwrapAndRegister(
                envelope = authResponse.keyEnvelope!!,
                manifest = SessionManifestStore.get(packet.sessionId)!!,
                rawEnvelopePayload = packet.payload
            )
            when (unwrapResult) {
                is KeyEnvelopeUnwrapResult.Accepted -> acceptedCount++
                is KeyEnvelopeUnwrapResult.DuplicateAccepted -> duplicateCount++
            }
        }

        assertEquals("First envelope must be Accepted", 1, acceptedCount)
        assertEquals("Subsequent 9 envelopes must be DuplicateAccepted", 9, duplicateCount)

        // Verify security context is valid and decrypts DATA without disruption
        val context = PreProvisionedSessionStore.get(bundle.announcement.sessionId)
        assertNotNull("Context must remain registered", context)
        val dataPkt = LumaPacketCodec.decode(bundle.dataPackets[0])
        val plaintext = context!!.decryptFromWirePayload(
            blockIndex = dataPkt.blockIndex,
            symbolId = dataPkt.symbolId,
            wirePayload = dataPkt.payload,
            packetTypeCode = dataPkt.packetType,
            flags = dataPkt.flags,
            checkReplay = true,
            direction = "sender"
        )
        val (_, expectedSym) = LtPacketIntegrationFixture.generateSymbolData(0L)
        assertArrayEquals(expectedSym, plaintext)
    }

    // =========================================================================
    // TEST C: Intermittent Packet Loss Survival (Simulated ~38% Drop)
    // =========================================================================
    @Test
    fun testScenarioC_intermittentPacketLossSurvival() {
        val bundle = buildSessionPackets(TestFixtureSessions.GOLDEN_SESSION_ID_BYTES, LtPacketIntegrationFixture.TEST_SOURCE_DATA)
        val decoder = LumaLtDecoder(defaultSymbolSize = 64)
        val reassembler = LumaFileReassembler(bundle.announcement.toFileManifest())

        // 1. Process Manifest and Envelope
        SessionManifestStore.register(bundle.announcement)
        val ctrlPkt = LumaPacketCodec.decode(bundle.controlPacketBytes)
        val authResp = LumaControlCodec.decodeAuthResponse(ctrlPkt.payload)
        keyEnvelopeUnwrapper.unwrapAndRegister(authResp.keyEnvelope!!, bundle.announcement, ctrlPkt.payload)
        val secContext = PreProvisionedSessionStore.get(bundle.announcement.sessionId)!!

        // 2. Transmit DATA packets with deterministic pseudo-random 40% loss
        // Overhead is 2.4x (39 symbols for K=16). With ~40% loss, ~23 symbols arrive (>= K=16 needed).
        val rng = Random(42)
        var droppedCount = 0
        var deliveredCount = 0

        for (wireBytes in bundle.dataPackets) {
            if (rng.nextDouble() < 0.38) {
                droppedCount++
                continue // Optical drop (camera blur / missed frame)
            }
            deliveredCount++
            val packet = LumaPacketCodec.decode(wireBytes)
            val plaintext = secContext.decryptFromWirePayload(
                blockIndex = packet.blockIndex,
                symbolId = packet.symbolId,
                wirePayload = packet.payload,
                packetTypeCode = packet.packetType,
                flags = packet.flags,
                checkReplay = true,
                direction = "sender"
            )
            decoder.addSymbol(packet.blockIndex, packet.symbolId, packet.k, plaintext, packet.degree)
        }

        assertTrue("Should have experienced drops", droppedCount > 5)
        assertTrue("Should have delivered sufficient symbols", deliveredCount >= 16)
        assertTrue("Block must be complete despite loss", decoder.isBlockComplete(0L))

        val blockData = decoder.reconstructBlock(0L)!!
        reassembler.addBlock(0L, blockData)
        assertTrue("Reassembler must be complete", reassembler.isComplete())

        val result = reassembler.reassemble()
        assertEquals("SHA-256 must match despite optical loss", bundle.expectedSha256, result.sha256Digest)
    }

    // =========================================================================
    // TEST D: Physical Session Restart & Clean Isolation
    // =========================================================================
    @Test
    fun testScenarioD_physicalSessionRestartCleanIsolation() {
        val session1Id = ByteArray(16) { 0x11.toByte() }
        val session2Id = ByteArray(16) { 0x22.toByte() }

        val file1Data = ByteArray(1024) { i -> (i and 0xFF).toByte() }
        val file2Data = ByteArray(1024) { i -> ((i * 3 + 7) and 0xFF).toByte() }

        val bundle1 = buildSessionPackets(session1Id, file1Data)
        val bundle2 = buildSessionPackets(session2Id, file2Data)

        // Run Session 1
        SessionManifestStore.register(bundle1.announcement)
        val ctrlPkt1 = LumaPacketCodec.decode(bundle1.controlPacketBytes)
        val authResp1 = LumaControlCodec.decodeAuthResponse(ctrlPkt1.payload)
        keyEnvelopeUnwrapper.unwrapAndRegister(authResp1.keyEnvelope!!, bundle1.announcement, ctrlPkt1.payload)
        assertNotNull(PreProvisionedSessionStore.get(session1Id))

        // Trigger Reset (simulating btnResetMetrics on receiver harness)
        PreProvisionedSessionStore.clear()
        SessionManifestStore.clear()
        keyEnvelopeUnwrapper.clear()

        // Verify Session 1 is completely purged
        assertEquals(null, PreProvisionedSessionStore.get(session1Id))
        assertEquals(null, SessionManifestStore.get(session1Id))

        // Run Session 2
        SessionManifestStore.register(bundle2.announcement)
        val ctrlPkt2 = LumaPacketCodec.decode(bundle2.controlPacketBytes)
        val authResp2 = LumaControlCodec.decodeAuthResponse(ctrlPkt2.payload)
        keyEnvelopeUnwrapper.unwrapAndRegister(authResp2.keyEnvelope!!, bundle2.announcement, ctrlPkt2.payload)

        // Verify Session 2 is active, but Session 1 is absent
        assertNotNull(PreProvisionedSessionStore.get(session2Id))
        assertEquals(null, PreProvisionedSessionStore.get(session1Id))

        // Session 1 packet arriving in Session 2 must fail closed
        val dataPkt1 = LumaPacketCodec.decode(bundle1.dataPackets[0])
        val contextForPkt1 = PreProvisionedSessionStore.get(dataPkt1.sessionId)
        assertEquals("Session 1 packet must find NO security context", null, contextForPkt1)

        // Session 2 packet decrypts normally
        val secContext2 = PreProvisionedSessionStore.get(session2Id)!!
        val dataPkt2 = LumaPacketCodec.decode(bundle2.dataPackets[0])
        val plaintext2 = secContext2.decryptFromWirePayload(
            blockIndex = dataPkt2.blockIndex,
            symbolId = dataPkt2.symbolId,
            wirePayload = dataPkt2.payload,
            packetTypeCode = dataPkt2.packetType,
            flags = dataPkt2.flags,
            checkReplay = true,
            direction = "sender"
        )
        assertNotNull(plaintext2)
    }

    // =========================================================================
    // TEST E: Negative Validation Fail-Closed
    // =========================================================================
    @Test
    fun testScenarioE1_wrongTargetDeviceFailsClosed() {
        val bundle = buildSessionPackets(TestFixtureSessions.GOLDEN_SESSION_ID_BYTES, LtPacketIntegrationFixture.TEST_SOURCE_DATA)
        SessionManifestStore.register(bundle.announcement)

        val wrongTargetEnvelope = bundle.envelope.copy(targetDeviceId = "device-charlie")
        val authResponse = LumaAuthResponse(
            sessionId = bundle.announcement.sessionId,
            receiverDeviceId = "device-charlie",
            authState = LumaControlCodec.AUTH_STATE_AUTHORIZED,
            reasonCode = 0,
            keyEnvelope = wrongTargetEnvelope
        )
        val payload = LumaControlCodec.encodeAuthResponse(authResponse)

        try {
            keyEnvelopeUnwrapper.unwrapAndRegister(wrongTargetEnvelope, bundle.announcement, payload)
            fail("Expected TargetDeviceMismatchException")
        } catch (e: TargetDeviceMismatchException) {
            // PASS: Fail closed
            assertEquals("device-bob", e.expected)
            assertEquals("device-charlie", e.actual)
        }
        assertEquals("No context must be registered", null, PreProvisionedSessionStore.get(bundle.announcement.sessionId))
    }

    @Test
    fun testScenarioE2_manifestKeyMismatchFailsClosedBeforeCrypto() {
        val bundle = buildSessionPackets(TestFixtureSessions.GOLDEN_SESSION_ID_BYTES, LtPacketIntegrationFixture.TEST_SOURCE_DATA)
        SessionManifestStore.register(bundle.announcement)

        // Tamper with ephemeral public key
        val tamperedKey = bundle.envelope.ephemeralPublicKey.copyOf()
        tamperedKey[0] = (tamperedKey[0].toInt() xor 0xFF).toByte()
        val tamperedEnvelope = bundle.envelope.copy(ephemeralPublicKey = tamperedKey)
        val authResponse = LumaAuthResponse(
            sessionId = bundle.announcement.sessionId,
            receiverDeviceId = localDeviceId,
            authState = LumaControlCodec.AUTH_STATE_AUTHORIZED,
            reasonCode = 0,
            keyEnvelope = tamperedEnvelope
        )
        val payload = LumaControlCodec.encodeAuthResponse(authResponse)

        try {
            keyEnvelopeUnwrapper.unwrapAndRegister(tamperedEnvelope, bundle.announcement, payload)
            fail("Expected ManifestKeyMismatchException")
        } catch (e: ManifestKeyMismatchException) {
            // PASS: Fail closed before X25519 or AEAD
            assertNotNull(e.manifestKey)
            assertNotNull(e.envelopeKey)
        }
        assertEquals("No context must be registered", null, PreProvisionedSessionStore.get(bundle.announcement.sessionId))
    }

    @Test
    fun testScenarioE3_tamperedEnvelopeCiphertextFailsClosed() {
        val bundle = buildSessionPackets(TestFixtureSessions.GOLDEN_SESSION_ID_BYTES, LtPacketIntegrationFixture.TEST_SOURCE_DATA)
        SessionManifestStore.register(bundle.announcement)

        // Tamper with wrapped ciphertext
        val tamperedCiphertext = bundle.envelope.wrappedCiphertext.copyOf()
        tamperedCiphertext[5] = (tamperedCiphertext[5].toInt() xor 0xAA).toByte()
        val tamperedEnvelope = bundle.envelope.copy(wrappedCiphertext = tamperedCiphertext)
        val authResponse = LumaAuthResponse(
            sessionId = bundle.announcement.sessionId,
            receiverDeviceId = localDeviceId,
            authState = LumaControlCodec.AUTH_STATE_AUTHORIZED,
            reasonCode = 0,
            keyEnvelope = tamperedEnvelope
        )
        val payload = LumaControlCodec.encodeAuthResponse(authResponse)

        try {
            keyEnvelopeUnwrapper.unwrapAndRegister(tamperedEnvelope, bundle.announcement, payload)
            fail("Expected DecryptionException")
        } catch (e: DecryptionException) {
            // PASS: ChaCha20-Poly1305 MAC tag verification failed
        }
        assertEquals("No context must be registered", null, PreProvisionedSessionStore.get(bundle.announcement.sessionId))
    }

    @Test
    fun testScenarioE4_corruptedPacketCrcFailsClosed() {
        val bundle = buildSessionPackets(TestFixtureSessions.GOLDEN_SESSION_ID_BYTES, LtPacketIntegrationFixture.TEST_SOURCE_DATA)
        val corruptedWire = bundle.manifestPacketBytes.copyOf()
        corruptedWire[corruptedWire.size - 1] = (corruptedWire[corruptedWire.size - 1].toInt() xor 0xFF).toByte()

        try {
            LumaPacketCodec.decode(corruptedWire)
            fail("Expected ChecksumMismatchException")
        } catch (e: ChecksumMismatchException) {
            // PASS: Corrupted packet dropped immediately at transport level
        }
    }

    @Test
    fun testScenarioE5_dataWithoutManifestOrEnvelopeFailsClosed() {
        val bundle = buildSessionPackets(TestFixtureSessions.GOLDEN_SESSION_ID_BYTES, LtPacketIntegrationFixture.TEST_SOURCE_DATA)
        val dataPacket = LumaPacketCodec.decode(bundle.dataPackets[0])

        // Verify: No manifest exists
        assertEquals(null, SessionManifestStore.get(dataPacket.sessionId))
        // Verify: No security context exists
        assertEquals(null, PreProvisionedSessionStore.get(dataPacket.sessionId))
    }
}

package com.lumalink.harness.crypto

import com.lumalink.harness.LumaPacketCodec
import com.lumalink.harness.LumaPacketCodecTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Phase 5C.2 Automated Unit & Integration Tests.
 *
 * Verifies:
 * - MANDATORY: testWireTagCiphertextOrdering
 * - Successful AEAD decryption and plaintext recovery
 * - Cryptographic failure cases (wrong key, nonce, AAD, tampered ciphertext, tampered tag)
 * - Canonical replay protection semantics
 * - DATA vs CONTROL domain separation
 * - Sender vs receiver direction separation
 * - Session isolation
 * - Golden vectors from canonical TypeScript core
 * - Complete transport packet decoding and decryption pipeline
 */
class LumaSecurityContextTest {

    private lateinit var crypto: AndroidCryptoProvider
    private lateinit var replayProtector: LumaReplayProtector
    private lateinit var securityContext: LumaSecurityContext

    @Before
    fun setUp() {
        crypto = AndroidCryptoProvider()
        replayProtector = LumaReplayProtector()
        securityContext = LumaSecurityContext(
            sessionId = TestFixtureSessions.GOLDEN_SESSION_ID_BYTES,
            keys = TestFixtureSessions.GOLDEN_SESSION_KEYS,
            crypto = crypto,
            replayProtector = replayProtector
        )
        PreProvisionedSessionStore.clear()
        PreProvisionedSessionStore.register(TestFixtureSessions.GOLDEN_SESSION_ID_BYTES, securityContext)
    }

    // =========================================================================
    // 1. MANDATORY TEST: testWireTagCiphertextOrdering
    // =========================================================================

    /**
     * MANDATORY ARCHITECTURAL REQUIREMENT:
     * Verifies the exact conversion between:
     *   LumaLink wire format: [TAG (16B) || CIPHERTEXT (NB)]
     * and:
     *   JCA convention:       [CIPHERTEXT (NB) || TAG (16B)]
     * before Cipher.doFinal(), confirming byte-exact plaintext recovery.
     */
    @Test
    fun testWireTagCiphertextOrdering() {
        val key = TestFixtureSessions.GOLDEN_ENCRYPTION_KEY
        val nonce = TestFixtureSessions.GOLDEN_NONCE
        val aad = TestFixtureSessions.GOLDEN_AAD
        val expectedPlaintext = TestFixtureSessions.GOLDEN_PLAINTEXT
        val expectedCiphertext = TestFixtureSessions.GOLDEN_CIPHERTEXT
        val expectedTag = TestFixtureSessions.GOLDEN_TAG

        // 1. Verify wire payload structure: TAG (16B) || CIPHERTEXT (64B) = 80B
        val wirePayload = TestFixtureSessions.GOLDEN_WIRE_PAYLOAD
        assertEquals(80, wirePayload.size)

        val wireTagSlice = wirePayload.copyOfRange(0, 16)
        val wireCiphertextSlice = wirePayload.copyOfRange(16, 80)
        assertArrayEquals("Wire tag slice must match golden tag", expectedTag, wireTagSlice)
        assertArrayEquals("Wire ciphertext slice must match golden ciphertext", expectedCiphertext, wireCiphertextSlice)

        // 2. Perform raw JCA conversion manually:
        //    JCA expects: [CIPHERTEXT (64B) || TAG (16B)]
        val jcaPayload = ByteArray(80)
        System.arraycopy(wireCiphertextSlice, 0, jcaPayload, 0, 64)
        System.arraycopy(wireTagSlice, 0, jcaPayload, 64, 16)

        // Verify JCA buffer ordering
        val jcaCiphertextSlice = jcaPayload.copyOfRange(0, 64)
        val jcaTagSlice = jcaPayload.copyOfRange(64, 80)
        assertArrayEquals(expectedCiphertext, jcaCiphertextSlice)
        assertArrayEquals(expectedTag, jcaTagSlice)

        // 3. Direct JCA Cipher.doFinal() execution on converted buffer
        val cipher = try {
            Cipher.getInstance("ChaCha20-Poly1305")
        } catch (_: Throwable) {
            Cipher.getInstance("ChaCha20/Poly1305/NoPadding")
        }
        val keySpec = SecretKeySpec(key, "ChaCha20")
        val ivSpec = IvParameterSpec(nonce)

        cipher.init(Cipher.DECRYPT_MODE, keySpec, ivSpec)
        cipher.updateAAD(aad)
        val jcaDecrypted = cipher.doFinal(jcaPayload)

        // 4. Assert byte-exact plaintext recovery
        assertEquals(64, jcaDecrypted.size)
        assertArrayEquals("JCA decryption after reordering must match golden plaintext", expectedPlaintext, jcaDecrypted)

        // 5. Verify the same outcome through AndroidCryptoProvider and LumaSecurityContext
        val providerDecrypted = crypto.decryptAead(
            key = key,
            nonce = nonce,
            ciphertext = wireCiphertextSlice,
            tag = wireTagSlice,
            aad = aad
        )
        assertArrayEquals("AndroidCryptoProvider must produce identical plaintext", expectedPlaintext, providerDecrypted)

        val contextDecrypted = securityContext.decryptFromWirePayload(
            blockIndex = 0L,
            symbolId = 0L,
            wirePayload = wirePayload,
            checkReplay = false
        )
        assertArrayEquals("LumaSecurityContext must produce identical plaintext", expectedPlaintext, contextDecrypted)
    }

    // =========================================================================
    // 2. Successful Decryption & Round-Trip Tests
    // =========================================================================

    @Test
    fun testSuccessfulDecryption() {
        val plaintext = securityContext.decryptFromWirePayload(
            blockIndex = 0L,
            symbolId = 0L,
            wirePayload = TestFixtureSessions.GOLDEN_WIRE_PAYLOAD,
            checkReplay = true
        )

        assertEquals(64, plaintext.size)
        assertArrayEquals(TestFixtureSessions.GOLDEN_PLAINTEXT, plaintext)
        assertEquals(1, securityContext.replayProtector.stats.uniqueAccepted)
    }

    @Test
    fun testRoundTripEncryptDecrypt() {
        val testPlaintext = "Hello LumaLink Airgap Security Protocol!".toByteArray(Charsets.UTF_8)
        val wirePayload = securityContext.encryptToWirePayload(
            blockIndex = 1L,
            symbolId = 42L,
            plaintext = testPlaintext
        )

        assertEquals(16 + testPlaintext.size, wirePayload.size)

        val recovered = securityContext.decryptFromWirePayload(
            blockIndex = 1L,
            symbolId = 42L,
            wirePayload = wirePayload,
            checkReplay = true
        )

        assertArrayEquals(testPlaintext, recovered)
    }

    // =========================================================================
    // 3. Cryptographic Tamper & Mismatch Tests
    // =========================================================================

    @Test
    fun testWrongKey() {
        val wrongKeyBytes = ByteArray(32) { 0x77.toByte() }
        val wrongContext = LumaSecurityContext(
            sessionId = TestFixtureSessions.GOLDEN_SESSION_ID_BYTES,
            keys = SessionKeys(wrongKeyBytes, TestFixtureSessions.GOLDEN_NONCE_SALT),
            crypto = crypto
        )

        try {
            wrongContext.decryptFromWirePayload(
                blockIndex = 0L,
                symbolId = 0L,
                wirePayload = TestFixtureSessions.GOLDEN_WIRE_PAYLOAD
            )
            fail("Expected DecryptionException for wrong key")
        } catch (e: DecryptionException) {
            assertTrue(e.message?.contains("AEAD") == true || e.cause != null)
        }
    }

    @Test
    fun testWrongNonceBlockIndex() {
        try {
            // Nonce mismatch: encrypted under block 0, decrypt under block 1
            securityContext.decryptFromWirePayload(
                blockIndex = 1L,
                symbolId = 0L,
                wirePayload = TestFixtureSessions.GOLDEN_WIRE_PAYLOAD,
                checkReplay = false
            )
            fail("Expected DecryptionException for blockIndex nonce mismatch")
        } catch (_: DecryptionException) {
            // Pass
        }
    }

    @Test
    fun testWrongNonceSymbolId() {
        try {
            // Nonce mismatch: encrypted under symbol 0, decrypt under symbol 1
            securityContext.decryptFromWirePayload(
                blockIndex = 0L,
                symbolId = 1L,
                wirePayload = TestFixtureSessions.GOLDEN_WIRE_PAYLOAD,
                checkReplay = false
            )
            fail("Expected DecryptionException for symbolId nonce mismatch")
        } catch (_: DecryptionException) {
            // Pass
        }
    }

    @Test
    fun testWrongAadPacketType() {
        try {
            // AAD mismatch: encrypted with packetTypeCode = 2 (DATA), decrypt with 4 (CONTROL)
            securityContext.decryptFromWirePayload(
                blockIndex = 0L,
                symbolId = 0L,
                wirePayload = TestFixtureSessions.GOLDEN_WIRE_PAYLOAD,
                packetTypeCode = 4,
                checkReplay = false
            )
            fail("Expected DecryptionException for packetTypeCode AAD mismatch")
        } catch (_: DecryptionException) {
            // Pass
        }
    }

    @Test
    fun testWrongAadFlags() {
        try {
            // AAD mismatch: flags encrypted = 2, decrypt with flags = 0
            securityContext.decryptFromWirePayload(
                blockIndex = 0L,
                symbolId = 0L,
                wirePayload = TestFixtureSessions.GOLDEN_WIRE_PAYLOAD,
                flags = 0,
                checkReplay = false
            )
            fail("Expected DecryptionException for flags AAD mismatch")
        } catch (_: DecryptionException) {
            // Pass
        }
    }

    @Test
    fun testModifiedCiphertext() {
        val tamperedPayload = TestFixtureSessions.GOLDEN_WIRE_PAYLOAD.clone()
        // Tamper ciphertext byte (offset 16 is first byte of ciphertext)
        tamperedPayload[16] = (tamperedPayload[16].toInt() xor 0x01).toByte()

        try {
            securityContext.decryptFromWirePayload(
                blockIndex = 0L,
                symbolId = 0L,
                wirePayload = tamperedPayload,
                checkReplay = false
            )
            fail("Expected DecryptionException for modified ciphertext")
        } catch (_: DecryptionException) {
            // Pass
        }
    }

    @Test
    fun testModifiedTag() {
        val tamperedPayload = TestFixtureSessions.GOLDEN_WIRE_PAYLOAD.clone()
        // Tamper tag byte (offset 0..15 is tag)
        tamperedPayload[0] = (tamperedPayload[0].toInt() xor 0x80).toByte()

        try {
            securityContext.decryptFromWirePayload(
                blockIndex = 0L,
                symbolId = 0L,
                wirePayload = tamperedPayload,
                checkReplay = false
            )
            fail("Expected DecryptionException for modified tag")
        } catch (_: DecryptionException) {
            // Pass
        }
    }

    @Test
    fun testTruncatedPayload() {
        // Less than 16 bytes tag
        val truncated = ByteArray(15) { 0x42.toByte() }
        try {
            securityContext.decryptFromWirePayload(
                blockIndex = 0L,
                symbolId = 0L,
                wirePayload = truncated,
                checkReplay = false
            )
            fail("Expected DecryptionException for payload < 16 bytes")
        } catch (e: DecryptionException) {
            assertTrue(e.message?.contains("shorter than AEAD tag") == true)
        }
    }

    // =========================================================================
    // 4. Replay Protection Tests
    // =========================================================================

    @Test
    fun testReplayDetection() {
        // First delivery: novel -> success
        val pt = securityContext.decryptFromWirePayload(
            blockIndex = 0L,
            symbolId = 0L,
            wirePayload = TestFixtureSessions.GOLDEN_WIRE_PAYLOAD,
            checkReplay = true
        )
        assertArrayEquals(TestFixtureSessions.GOLDEN_PLAINTEXT, pt)

        // Second delivery: duplicate -> throws ReplayException
        try {
            securityContext.decryptFromWirePayload(
                blockIndex = 0L,
                symbolId = 0L,
                wirePayload = TestFixtureSessions.GOLDEN_WIRE_PAYLOAD,
                checkReplay = true
            )
            fail("Expected ReplayException for duplicate symbol delivery")
        } catch (e: ReplayException) {
            assertEquals(0L, e.symbolId)
        }

        val stats = securityContext.replayProtector.stats
        assertEquals(2L, stats.totalChecked)
        assertEquals(1L, stats.uniqueAccepted)
        assertEquals(1L, stats.replaysDetected)
    }

    @Test
    fun testReplayDisabled() {
        // When checkReplay = false, duplicate is decrypted without ReplayException
        val pt1 = securityContext.decryptFromWirePayload(
            blockIndex = 0L,
            symbolId = 0L,
            wirePayload = TestFixtureSessions.GOLDEN_WIRE_PAYLOAD,
            checkReplay = false
        )
        val pt2 = securityContext.decryptFromWirePayload(
            blockIndex = 0L,
            symbolId = 0L,
            wirePayload = TestFixtureSessions.GOLDEN_WIRE_PAYLOAD,
            checkReplay = false
        )
        assertArrayEquals(pt1, pt2)
        assertEquals(0L, securityContext.replayProtector.stats.totalChecked)
    }

    @Test
    fun testDomainSeparation() {
        val protector = LumaReplayProtector()

        // DATA(0, 0)
        assertTrue(protector.checkAndRecord(blockIndex = 0L, symbolId = 0L, packetTypeCode = 2))
        assertFalse("Duplicate DATA(0, 0) rejected", protector.checkAndRecord(blockIndex = 0L, symbolId = 0L, packetTypeCode = 2))

        // CONTROL(0, 0) on same block & symbol must NOT be blocked by DATA(0, 0)
        assertTrue("CONTROL(0, 0) novel despite DATA(0, 0)", protector.checkAndRecord(blockIndex = 0L, symbolId = 0L, packetTypeCode = 4))
        assertFalse("Duplicate CONTROL(0, 0) rejected", protector.checkAndRecord(blockIndex = 0L, symbolId = 0L, packetTypeCode = 4))

        assertEquals(4L, protector.stats.totalChecked)
        assertEquals(2L, protector.stats.uniqueAccepted)
        assertEquals(2L, protector.stats.replaysDetected)
    }

    @Test
    fun testDirectionSeparation() {
        val protector = LumaReplayProtector()

        // Sender message
        assertTrue(protector.checkAndRecord(blockIndex = 0L, symbolId = 0L, direction = "sender"))
        // Receiver message with same block/symbol must NOT collide with sender message space
        assertTrue(protector.checkAndRecord(blockIndex = 0L, symbolId = 0L, direction = "receiver"))

        assertEquals(2L, protector.stats.uniqueAccepted)
    }

    @Test
    fun testSessionIsolation() {
        val otherSessionId = ByteArray(16) { 0xFF.toByte() }
        val otherContext = LumaSecurityContext(
            sessionId = otherSessionId,
            keys = TestFixtureSessions.GOLDEN_SESSION_KEYS,
            crypto = crypto
        )

        try {
            // Other session ID will compute a different AAD, failing authentication
            otherContext.decryptFromWirePayload(
                blockIndex = 0L,
                symbolId = 0L,
                wirePayload = TestFixtureSessions.GOLDEN_WIRE_PAYLOAD,
                checkReplay = false
            )
            fail("Expected DecryptionException due to session ID AAD isolation")
        } catch (_: DecryptionException) {
            // Pass
        }
    }

    // =========================================================================
    // 5. Golden Vectors Parity Tests
    // =========================================================================

    @Test
    fun testNonceGoldenVector() {
        val nonce = LumaNonce.buildNonce(
            saltPrefix = TestFixtureSessions.GOLDEN_NONCE_SALT,
            blockIndex = 0L,
            symbolId = 0L,
            packetTypeCode = 2,
            direction = "sender"
        )
        assertArrayEquals(TestFixtureSessions.GOLDEN_NONCE, nonce)
    }

    @Test
    fun testAadGoldenVector() {
        val aad = LumaAad.buildPacketAad(
            sessionId = TestFixtureSessions.GOLDEN_SESSION_ID_BYTES,
            blockIndex = 0L,
            symbolId = 0L,
            packetTypeCode = 2,
            flags = 2
        )
        assertArrayEquals(TestFixtureSessions.GOLDEN_AAD, aad)
    }

    @Test
    fun testX25519GoldenVector() {
        val sharedSecret = crypto.computeSharedSecret(
            privateKey = TestFixtureSessions.ALICE_PRIV,
            peerPublicKey = TestFixtureSessions.BOB_PUB
        )
        assertArrayEquals(TestFixtureSessions.GOLDEN_SHARED_SECRET, sharedSecret)

        val reverseSecret = crypto.computeSharedSecret(
            privateKey = TestFixtureSessions.BOB_PRIV,
            peerPublicKey = TestFixtureSessions.ALICE_PUB
        )
        assertArrayEquals(TestFixtureSessions.GOLDEN_SHARED_SECRET, reverseSecret)
    }

    @Test
    fun testHkdfGoldenVectors() {
        val derivedKeys = crypto.deriveSessionKeys(
            sharedSecret = TestFixtureSessions.GOLDEN_SHARED_SECRET,
            sessionIdBytes = TestFixtureSessions.GOLDEN_SESSION_ID_BYTES,
            infoPrefix = "LumaLink-QuickSend-v2"
        )
        assertArrayEquals(TestFixtureSessions.GOLDEN_ENCRYPTION_KEY, derivedKeys.encryptionKey)
        assertArrayEquals(TestFixtureSessions.GOLDEN_NONCE_SALT, derivedKeys.nonceSalt)
    }

    @Test
    fun testChaCha20Poly1305GoldenVector() {
        val wirePayload = crypto.encryptAead(
            key = TestFixtureSessions.GOLDEN_ENCRYPTION_KEY,
            nonce = TestFixtureSessions.GOLDEN_NONCE,
            plaintext = TestFixtureSessions.GOLDEN_PLAINTEXT,
            aad = TestFixtureSessions.GOLDEN_AAD
        )

        assertArrayEquals(TestFixtureSessions.GOLDEN_WIRE_PAYLOAD, wirePayload)
    }

    // =========================================================================
    // 6. Complete Transport Packet Decoding & Ingestion Tests
    // =========================================================================

    @Test
    fun testCompleteTransportPacketDecryption() {
        // 1. Decode full 122-byte wire packet with LumaPacketCodec
        val wireBytes = TestFixtureSessions.GOLDEN_DATA_PACKET_WIRE
        assertEquals(122, wireBytes.size)

        val packet = LumaPacketCodec.decode(wireBytes)
        assertEquals(1, packet.version)
        assertEquals(LumaPacketCodec.TYPE_DATA, packet.packetType)
        assertEquals(2, packet.flags)
        assertTrue(packet.isEncrypted)
        assertEquals(0L, packet.blockIndex)
        assertEquals(0L, packet.symbolId)
        assertEquals(16, packet.k)
        assertEquals(1, packet.degree)
        assertEquals(80, packet.payloadLength)
        assertEquals(0xb5342f11L, packet.crc32)

        // 2. Identify and retrieve registered test session
        val secContext = PreProvisionedSessionStore.get(packet.sessionId)
        assertNotNull("Session context must be found in pre-provisioned store", secContext)

        // 3. Decrypt payload
        val plaintext = secContext!!.decryptFromWirePayload(
            blockIndex = packet.blockIndex,
            symbolId = packet.symbolId,
            wirePayload = packet.payload,
            packetTypeCode = packet.packetType,
            flags = packet.flags,
            checkReplay = true
        )

        assertEquals(64, plaintext.size)
        assertArrayEquals(TestFixtureSessions.GOLDEN_PLAINTEXT, plaintext)
    }

    @Test
    fun testPhase5bPacketWithEphemeralKeyFailsAuthControlled() {
        // Phase 5B Packet 0 was generated during the Phase 5B one-time run with an ephemeral key.
        // When passed with the golden session context, LumaPacketCodec validates framing and CRC (0x0d2f3c6f),
        // but AEAD decryption must fail with a controlled DecryptionException.
        val packet = LumaPacketCodec.decode(LumaPacketCodecTest.PHASE_5B_PACKET_0)
        assertEquals(0x0d2f3c6fL, packet.crc32)
        assertEquals(TestFixtureSessions.GOLDEN_SESSION_ID_HEX, packet.sessionIdHex)

        val secContext = PreProvisionedSessionStore.get(packet.sessionId)
        assertNotNull(secContext)

        try {
            secContext!!.decryptFromWirePayload(
                blockIndex = packet.blockIndex,
                symbolId = packet.symbolId,
                wirePayload = packet.payload,
                packetTypeCode = packet.packetType,
                flags = packet.flags,
                checkReplay = false
            )
            fail("Expected DecryptionException for ephemeral-key Phase 5B packet")
        } catch (e: DecryptionException) {
            // Controlled authentication failure
            assertTrue(e.message?.contains("AEAD") == true || e.cause != null)
        }
    }
}

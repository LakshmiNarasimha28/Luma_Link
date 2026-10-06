package com.lumalink.harness.crypto

import com.lumalink.harness.session.LumaSessionAnnouncement
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Unit and security invariant tests for [LumaKeyEnvelopeUnwrapper].
 * Enforces:
 * 1. Manifest-key binding (Requirement 1)
 * 2. Complete envelope deduplication (Requirement 2)
 * 3. Cryptographic envelope AEAD validation
 * 4. Session isolation
 */
class LumaKeyEnvelopeUnwrapperTest {

    private val crypto = AndroidCryptoProvider()
    private val localDeviceId = "device-bob"
    private val localPrivateKey = TestFixtureSessions.BOB_PRIV
    private lateinit var unwrapper: LumaKeyEnvelopeUnwrapper

    private val masterSharedSecret = TestFixtureSessions.hexToBytes(
        "5566778899aabbccddeeff00112233445566778899aabbccddeeff0011223344"
    )

    private val goldenManifest = LumaSessionAnnouncement(
        sessionId = TestFixtureSessions.GOLDEN_SESSION_ID_BYTES,
        mode = "quick",
        senderDeviceId = "sender-alice",
        senderPublicKey = TestFixtureSessions.ALICE_PUB,
        fileName = "test.bin",
        fileSize = 1024L,
        sha256Digest = "6d08077b4795f29ba27c3f7802ba28d26bf8cc55f8b60e6081bbda4e15c7760f",
        symbolSize = 64,
        symbolsPerBlock = 16,
        totalBlocks = 1,
        timestamp = 1728120000000L
    )

    @Before
    fun setUp() {
        PreProvisionedSessionStore.clear()
        unwrapper = LumaKeyEnvelopeUnwrapper(
            localDeviceId = localDeviceId,
            localPrivateKey = localPrivateKey,
            crypto = crypto
        )
    }

    /**
     * Helper to create a valid encrypted envelope sealed for Bob by Alice.
     */
    private fun createValidEnvelope(
        senderPrivKey: ByteArray = TestFixtureSessions.ALICE_PRIV,
        senderPubKey: ByteArray = TestFixtureSessions.ALICE_PUB,
        sessionId: ByteArray = TestFixtureSessions.GOLDEN_SESSION_ID_BYTES,
        targetDeviceId: String = "device-bob",
        secret: ByteArray = masterSharedSecret,
        wrapNonce: ByteArray = crypto.hkdf(secret, sessionId, "test-nonce".toByteArray(), 12)
    ): Pair<LumaEncryptedKeyEnvelope, ByteArray> {
        // 1. Pairwise ECDH
        val pairwiseSecret = crypto.computeSharedSecret(senderPrivKey, TestFixtureSessions.BOB_PUB)

        // 2. HKDF wrap key
        val wrapKey = crypto.hkdf(
            ikm = pairwiseSecret,
            salt = sessionId,
            info = "LumaLink-KeyWrap-v1".toByteArray(Charsets.UTF_8),
            length = 32
        )

        // 3. AAD
        val aad = LumaKeyEnvelopeUnwrapper.buildEnvelopeAad(sessionId, targetDeviceId)

        // 4. Encrypt with ChaCha20-Poly1305 -> wire: [TAG (16B) || CIPHERTEXT (32B)]
        val wirePayload = crypto.encryptAead(
            key = wrapKey,
            nonce = wrapNonce,
            plaintext = secret,
            aad = aad
        )

        val tag = wirePayload.copyOfRange(0, 16)
        val ciphertext = wirePayload.copyOfRange(16, 48)

        val env = LumaEncryptedKeyEnvelope(
            targetDeviceId = targetDeviceId,
            ephemeralPublicKey = senderPubKey,
            wrapNonce = wrapNonce,
            wrapTag = tag,
            wrappedCiphertext = ciphertext
        )

        val authRes = LumaAuthResponse(
            sessionId = sessionId,
            receiverDeviceId = targetDeviceId,
            authState = LumaControlCodec.AUTH_STATE_AUTHORIZED,
            keyEnvelope = env
        )
        val rawBytes = LumaControlCodec.encodeAuthResponse(authRes)

        return Pair(env, rawBytes)
    }

    // =========================================================================
    // 1. Manifest-Key Binding Tests (Requirement 1)
    // =========================================================================

    @Test
    fun testManifestKeyBindingSuccessWhenKeysMatch() {
        val (envelope, rawBytes) = createValidEnvelope()

        val result = unwrapper.unwrapAndRegister(
            envelope = envelope,
            manifest = goldenManifest,
            rawEnvelopePayload = rawBytes
        )

        assertTrue("Must be Accepted", result is KeyEnvelopeUnwrapResult.Accepted)
        val accepted = result as KeyEnvelopeUnwrapResult.Accepted
        assertArrayEquals("Must recover exact master secret", masterSharedSecret, accepted.broadcastSecret)
        assertNotNull(PreProvisionedSessionStore.get(goldenManifest.sessionId))
    }

    @Test
    fun testManifestKeyMismatchFailsClosedBeforeCrypto() {
        // Sender pubkey in envelope differs from manifest
        val fakeSenderPub = ByteArray(32) { 0x55.toByte() }
        val (envelope, rawBytes) = createValidEnvelope(senderPubKey = fakeSenderPub)

        assertThrows(ManifestKeyMismatchException::class.java) {
            unwrapper.unwrapAndRegister(
                envelope = envelope,
                manifest = goldenManifest, // Expects ALICE_PUB
                rawEnvelopePayload = rawBytes
            )
        }

        // Verify NO crypto operation occurred and NO context was registered!
        assertEquals("PreProvisionedSessionStore must remain empty", 0, PreProvisionedSessionStore.count())
    }

    // =========================================================================
    // 2. Complete Envelope Deduplication Tests (Requirement 2)
    // =========================================================================

    @Test
    fun testCompleteIdenticalEnvelopeReturnsDuplicateAccepted() {
        val (envelope, rawBytes) = createValidEnvelope()

        // First presentation -> Accepted
        val firstResult = unwrapper.unwrapAndRegister(envelope, goldenManifest, rawBytes)
        assertTrue(firstResult is KeyEnvelopeUnwrapResult.Accepted)

        // Second presentation of identical bytes in optical carousel -> DuplicateAccepted
        val secondResult = unwrapper.unwrapAndRegister(envelope, goldenManifest, rawBytes)
        assertTrue("Duplicate presentation must be DuplicateAccepted", secondResult is KeyEnvelopeUnwrapResult.DuplicateAccepted)
    }

    @Test
    fun testConflictingEnvelopeWithChangedNonceFailsClosed() {
        val (envelope1, rawBytes1) = createValidEnvelope()
        unwrapper.unwrapAndRegister(envelope1, goldenManifest, rawBytes1)

        // Second envelope with different wrapNonce for the same active session
        val altNonce = ByteArray(12) { 0xFF.toByte() }
        val (envelope2, rawBytes2) = createValidEnvelope(wrapNonce = altNonce)

        assertThrows(ConflictingKeyEnvelopeException::class.java) {
            unwrapper.unwrapAndRegister(envelope2, goldenManifest, rawBytes2)
        }
    }

    @Test
    fun testConflictingEnvelopeWithChangedCiphertextFailsClosed() {
        val (envelope1, rawBytes1) = createValidEnvelope()
        unwrapper.unwrapAndRegister(envelope1, goldenManifest, rawBytes1)

        // Second envelope with different secret/ciphertext
        val altSecret = ByteArray(32) { 0x99.toByte() }
        val (envelope2, rawBytes2) = createValidEnvelope(secret = altSecret)

        assertThrows(ConflictingKeyEnvelopeException::class.java) {
            unwrapper.unwrapAndRegister(envelope2, goldenManifest, rawBytes2)
        }
    }

    // =========================================================================
    // 3. Cryptographic Validation & Tampering Tests
    // =========================================================================

    @Test
    fun testWrongReceiverPrivateKeyFailsDecryption() {
        // Unwrapper configured with Eve's keypair
        val evePrivKey = ByteArray(32) { 0x33.toByte() }
        val eveUnwrapper = LumaKeyEnvelopeUnwrapper(
            localDeviceId = localDeviceId,
            localPrivateKey = evePrivKey,
            crypto = crypto
        )

        val (envelope, rawBytes) = createValidEnvelope()

        assertThrows(DecryptionException::class.java) {
            eveUnwrapper.unwrapAndRegister(envelope, goldenManifest, rawBytes)
        }
    }

    @Test
    fun testWrongTargetDeviceFailsClosed() {
        val (envelope, rawBytes) = createValidEnvelope(targetDeviceId = "device-charlie")

        assertThrows(TargetDeviceMismatchException::class.java) {
            unwrapper.unwrapAndRegister(envelope, goldenManifest, rawBytes)
        }
    }

    @Test
    fun testCorruptedCiphertextFailsDecryption() {
        val (envelope, _) = createValidEnvelope()

        val corruptedCiphertext = envelope.wrappedCiphertext.copyOf()
        corruptedCiphertext[0] = (corruptedCiphertext[0].toInt() xor 0x01).toByte()

        val badEnv = envelope.copy(wrappedCiphertext = corruptedCiphertext)
        val badRes = LumaAuthResponse(
            sessionId = goldenManifest.sessionId,
            receiverDeviceId = localDeviceId,
            authState = LumaControlCodec.AUTH_STATE_AUTHORIZED,
            keyEnvelope = badEnv
        )
        val badRaw = LumaControlCodec.encodeAuthResponse(badRes)

        assertThrows(DecryptionException::class.java) {
            unwrapper.unwrapAndRegister(badEnv, goldenManifest, badRaw)
        }
    }

    @Test
    fun testCorruptedTagFailsDecryption() {
        val (envelope, _) = createValidEnvelope()

        val corruptedTag = envelope.wrapTag.copyOf()
        corruptedTag[0] = (corruptedTag[0].toInt() xor 0x01).toByte()

        val badEnv = envelope.copy(wrapTag = corruptedTag)
        val badRes = LumaAuthResponse(
            sessionId = goldenManifest.sessionId,
            receiverDeviceId = localDeviceId,
            authState = LumaControlCodec.AUTH_STATE_AUTHORIZED,
            keyEnvelope = badEnv
        )
        val badRaw = LumaControlCodec.encodeAuthResponse(badRes)

        assertThrows(DecryptionException::class.java) {
            unwrapper.unwrapAndRegister(badEnv, goldenManifest, badRaw)
        }
    }

    // =========================================================================
    // 4. Session Isolation Test
    // =========================================================================

    @Test
    fun testSessionAEnvelopeCannotDecryptSessionB() {
        val sessionBId = ByteArray(16) { 0xBB.toByte() }
        val manifestB = goldenManifest.copy(sessionId = sessionBId)

        // Envelope sealed under Session A
        val (envelopeA, rawBytesA) = createValidEnvelope()

        // Attempting to unwrap Envelope A under Manifest B fails AAD/salt binding
        assertThrows(DecryptionException::class.java) {
            unwrapper.unwrapAndRegister(envelopeA, manifestB, rawBytesA)
        }
    }
}

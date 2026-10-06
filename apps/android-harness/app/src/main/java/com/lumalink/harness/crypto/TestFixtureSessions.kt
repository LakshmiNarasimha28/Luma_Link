package com.lumalink.harness.crypto

import com.lumalink.harness.transfer.LumaFileManifest
import com.lumalink.harness.transfer.PreProvisionedManifestStore

/**
 * TEST-ONLY Cryptographic Fixture and Session Provisioning.
 *
 * NOT PART OF PRODUCTION CRYPTO PIPELINE.
 * Used exclusively for:
 * 1. Physical test execution on Android receiver harness (Samsung M04).
 * 2. Automated golden vector verification tests against canonical TypeScript reference.
 * 3. Pre-provisioning the test session without a dynamic key bootstrap mechanism.
 */
object TestFixtureSessions {

    fun hexToBytes(hex: String): ByteArray {
        val clean = hex.replace(" ", "").trim()
        val len = clean.length
        val data = ByteArray(len / 2)
        var i = 0
        while (i < len) {
            data[i / 2] = ((Character.digit(clean[i], 16) shl 4) + Character.digit(clean[i + 1], 16)).toByte()
            i += 2
        }
        return data
    }

    // Canonical TypeScript Core Golden Vector Constants
    const val GOLDEN_SESSION_ID_HEX = "09e99973c478442daf602baf76b1d795"
    const val GOLDEN_SESSION_ID_UUID = "09e99973-c478-442d-af60-2baf76b1d795"
    val GOLDEN_SESSION_ID_BYTES: ByteArray = hexToBytes(GOLDEN_SESSION_ID_HEX)

    // Golden File Manifests (Phase 5C.4)
    val GOLDEN_MANIFEST_1024B: LumaFileManifest by lazy {
        LumaFileManifest(
            sessionId = GOLDEN_SESSION_ID_BYTES,
            fileName = "golden-1024.bin",
            fileSize = 1024L,
            sha256Digest = "6d08077b4795f29ba27c3f7802ba28d26bf8cc55f8b60e6081bbda4e15c7760f",
            symbolSize = 64,
            symbolsPerBlock = 16,
            totalBlocks = 1
        )
    }

    val GOLDEN_MANIFEST_1000B: LumaFileManifest by lazy {
        LumaFileManifest(
            sessionId = GOLDEN_SESSION_ID_BYTES,
            fileName = "golden-1000.bin",
            fileSize = 1000L,
            sha256Digest = "0acbc8420eff771695d4a31a478b8f1627d54f8718aa6904cd4895d7eb92b7b7",
            symbolSize = 64,
            symbolsPerBlock = 16,
            totalBlocks = 1
        )
    }

    val GOLDEN_MANIFEST_2500B: LumaFileManifest by lazy {
        LumaFileManifest(
            sessionId = GOLDEN_SESSION_ID_BYTES,
            fileName = "golden-2500.bin",
            fileSize = 2500L,
            sha256Digest = "0ed48e0f1222e6cdbb46abb0be800ab6c14dfc25a1d4342bb7a750ac4a1ed710",
            symbolSize = 64,
            symbolsPerBlock = 16,
            totalBlocks = 3
        )
    }

    // X25519 Test Keys
    val ALICE_PRIV: ByteArray = hexToBytes("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20")
    val ALICE_PUB: ByteArray = hexToBytes("07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c")
    val BOB_PRIV: ByteArray = hexToBytes("8182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9fa0")
    val BOB_PUB: ByteArray = hexToBytes("883186b800b41d5cf0429695da9b3cc4f328ebcd184a6e482fa578c103f06c77")
    val GOLDEN_SHARED_SECRET: ByteArray = hexToBytes("c639664aff13ee2696db677b30b74d56103f38953ef4b5c50b87e2ac31b37367")

    // HKDF-Derived Session Keys
    val GOLDEN_ENCRYPTION_KEY: ByteArray = hexToBytes("dc520c4075f7336bba19add48106e7c5842bebf27e279d402f905135411c1657")
    val GOLDEN_NONCE_SALT: ByteArray = hexToBytes("10d922")
    val GOLDEN_SESSION_KEYS = SessionKeys(GOLDEN_ENCRYPTION_KEY, GOLDEN_NONCE_SALT)

    // Expected Golden Nonce and AAD
    val GOLDEN_NONCE: ByteArray = hexToBytes("0210d9220000000000000000")
    val GOLDEN_AAD: ByteArray = hexToBytes("09e99973c478442daf602baf76b1d79500000000000000000202")

    // Plaintext & AEAD Ciphertext/Tag Vectors
    val GOLDEN_PLAINTEXT: ByteArray = hexToBytes("5a5b58595e5f5c5d52535051565754554a4b48494e4f4c4d42434041464744457a7b78797e7f7c7d72737071767774756a6b68696e6f6c6d6263606166676465")
    val GOLDEN_CIPHERTEXT: ByteArray = hexToBytes("c13a4d685e8ecb2601828972a12879f2b6d746fd554be3c4bf55eeeefe111b241abd737adb8b4fbeda137fcff164ab7de424e8c307824ce2b5d4461b49e4d96a")
    val GOLDEN_TAG: ByteArray = hexToBytes("1935484bafc94cd575abf6609c3976db")

    // Wire Payload format: [TAG (16B) || CIPHERTEXT (64B)] = 80 bytes
    val GOLDEN_WIRE_PAYLOAD: ByteArray by lazy {
        val payload = ByteArray(80)
        System.arraycopy(GOLDEN_TAG, 0, payload, 0, 16)
        System.arraycopy(GOLDEN_CIPHERTEXT, 0, payload, 16, 64)
        payload
    }

    // Complete 122-byte validated LumaLink TransportPacket wire bytes
    // (Header 42B + Payload 80B, CRC32: 0xb5342f11)
    val GOLDEN_DATA_PACKET_WIRE: ByteArray by lazy {
        hexToBytes(
            "4c554d410102020009e99973c478442daf602baf76b1d7950000000000000000001000010050b5342f11" +
            "1935484bafc94cd575abf6609c3976db" +
            "c13a4d685e8ecb2601828972a12879f2b6d746fd554be3c4bf55eeeefe111b241abd737adb8b4fbeda137fcff164ab7de424e8c307824ce2b5d4461b49e4d96a"
        )
    }

    /**
     * Creates a test security context instance pre-configured with the golden session keys.
     */
    fun createGoldenSecurityContext(
        crypto: AndroidCryptoProvider = AndroidCryptoProvider(),
        replayProtector: LumaReplayProtector = LumaReplayProtector()
    ): LumaSecurityContext {
        return LumaSecurityContext(
            sessionId = GOLDEN_SESSION_ID_BYTES,
            keys = GOLDEN_SESSION_KEYS,
            crypto = crypto,
            replayProtector = replayProtector
        )
    }

    val GOLDEN_ANNOUNCEMENT_1024B: com.lumalink.harness.session.LumaSessionAnnouncement by lazy {
        com.lumalink.harness.session.LumaSessionAnnouncement(
            sessionId = GOLDEN_SESSION_ID_BYTES,
            mode = "quick",
            senderDeviceId = "sender-test-dev-01",
            senderPublicKey = ALICE_PUB,
            fileName = "golden-1024.bin",
            fileSize = 1024L,
            sha256Digest = "6d08077b4795f29ba27c3f7802ba28d26bf8cc55f8b60e6081bbda4e15c7760f",
            symbolSize = 64,
            symbolsPerBlock = 16,
            totalBlocks = 1,
            timestamp = 1728120000000L
        )
    }

    /**
     * Registers ONLY the cryptographic keys into PreProvisionedSessionStore.
     * Does NOT register any pre-provisioned manifest, ensuring the dynamic manifest pipeline is tested.
     */
    fun registerTestSessionKeys() {
        PreProvisionedSessionStore.register(
            sessionId = GOLDEN_SESSION_ID_BYTES,
            context = createGoldenSecurityContext()
        )
    }

    /**
     * Registers the test-only session into the pre-provisioned session store and manifest store.
     * Kept for legacy test compatibility.
     */
    fun registerTestSessions() {
        registerTestSessionKeys()
        PreProvisionedManifestStore.register(
            sessionId = GOLDEN_SESSION_ID_BYTES,
            manifest = GOLDEN_MANIFEST_1024B
        )
    }
}
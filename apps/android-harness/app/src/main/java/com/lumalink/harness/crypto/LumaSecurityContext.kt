package com.lumalink.harness.crypto

/**
 * Manages AEAD encryption, decryption, nonce generation, and replay protection
 * for an active LumaLink session.
 *
 * Implements strict injection of session keys, canonical AAD and Nonce binding,
 * and wire payload unpacking:
 *   LumaLink wire payload: [TAG (16B) || CIPHERTEXT (NB)]
 *   JCA convention:        [CIPHERTEXT (NB) || TAG (16B)]
 */
class LumaSecurityContext(
    val sessionId: ByteArray,
    val keys: SessionKeys,
    val crypto: AndroidCryptoProvider = AndroidCryptoProvider(),
    val replayProtector: LumaReplayProtector = LumaReplayProtector()
) {
    companion object {
        const val AUTH_TAG_LENGTH_BYTES = 16
        const val SESSION_ID_BYTES_LENGTH = 16
    }

    init {
        require(sessionId.size == SESSION_ID_BYTES_LENGTH) {
            "Session ID must be exactly $SESSION_ID_BYTES_LENGTH bytes, got ${sessionId.size}"
        }
    }

    /**
     * Decrypts and authenticates a transport packet's wire payload.
     *
     * Steps:
     * 1. Validates wire payload length >= 16 bytes.
     * 2. Performs replay protection check if enabled.
     * 3. Constructs the canonical 12-byte nonce.
     * 4. Constructs the canonical 26-byte AAD binding buffer.
     * 5. Unpacks wire payload [TAG (16B) || CIPHERTEXT (NB)] and adapts to JCA [CIPHERTEXT || TAG].
     * 6. Invokes ChaCha20-Poly1305 decryption.
     * 7. Returns authenticated plaintext or throws controlled DecryptionException.
     *
     * @param blockIndex Source block index
     * @param symbolId Symbol identifier or sequence counter
     * @param wirePayload Transport packet payload starting with 16-byte Poly1305 tag
     * @param packetTypeCode Packet domain (2 = DATA, 4 = CONTROL, etc.)
     * @param flags Packet header flags (e.g. 0x02 for FLAG_ENCRYPTED)
     * @param checkReplay Whether to check and record sequence in replay protector
     * @param direction Message flow direction ("sender" or "receiver")
     * @return Authenticated plaintext bytes
     * @throws DecryptionException if tag verification fails or data is truncated/corrupt
     * @throws ReplayException if sequence has already been received
     */
    fun decryptFromWirePayload(
        blockIndex: Long,
        symbolId: Long,
        wirePayload: ByteArray,
        packetTypeCode: Int = 2,
        flags: Int = 2,
        checkReplay: Boolean = true,
        direction: String = "sender"
    ): ByteArray {
        if (wirePayload.size < AUTH_TAG_LENGTH_BYTES) {
            throw DecryptionException("Wire payload is shorter than AEAD tag length (${wirePayload.size} < $AUTH_TAG_LENGTH_BYTES)")
        }

        if (checkReplay) {
            replayProtector.checkAndRecord(
                blockIndex = blockIndex,
                symbolId = symbolId,
                throwOnReplay = true,
                packetTypeCode = packetTypeCode,
                direction = direction
            )
        }

        val nonce = LumaNonce.buildNonce(
            saltPrefix = keys.nonceSalt,
            blockIndex = blockIndex,
            symbolId = symbolId,
            packetTypeCode = packetTypeCode,
            direction = direction
        )

        val aad = LumaAad.buildPacketAad(
            sessionId = sessionId,
            blockIndex = blockIndex,
            symbolId = symbolId,
            packetTypeCode = packetTypeCode,
            flags = flags
        )

        val tag = wirePayload.copyOfRange(0, AUTH_TAG_LENGTH_BYTES)
        val ciphertext = wirePayload.copyOfRange(AUTH_TAG_LENGTH_BYTES, wirePayload.size)

        return crypto.decryptAead(
            key = keys.encryptionKey,
            nonce = nonce,
            ciphertext = ciphertext,
            tag = tag,
            aad = aad
        )
    }

    fun decryptFromWirePayload(
        blockIndex: Int,
        symbolId: Int,
        wirePayload: ByteArray,
        packetTypeCode: Int = 2,
        flags: Int = 2,
        checkReplay: Boolean = true,
        direction: String = "sender"
    ): ByteArray = decryptFromWirePayload(blockIndex.toLong(), symbolId.toLong(), wirePayload, packetTypeCode, flags, checkReplay, direction)

    /**
     * Encrypts plaintext and packs into LumaLink wire format [TAG (16B) || CIPHERTEXT (NB)].
     */
    fun encryptToWirePayload(
        blockIndex: Long,
        symbolId: Long,
        plaintext: ByteArray,
        packetTypeCode: Int = 2,
        flags: Int = 2,
        direction: String = "sender"
    ): ByteArray {
        val nonce = LumaNonce.buildNonce(
            saltPrefix = keys.nonceSalt,
            blockIndex = blockIndex,
            symbolId = symbolId,
            packetTypeCode = packetTypeCode,
            direction = direction
        )

        val aad = LumaAad.buildPacketAad(
            sessionId = sessionId,
            blockIndex = blockIndex,
            symbolId = symbolId,
            packetTypeCode = packetTypeCode,
            flags = flags
        )

        return crypto.encryptAead(
            key = keys.encryptionKey,
            nonce = nonce,
            plaintext = plaintext,
            aad = aad
        )
    }

    fun encryptToWirePayload(
        blockIndex: Int,
        symbolId: Int,
        plaintext: ByteArray,
        packetTypeCode: Int = 2,
        flags: Int = 2,
        direction: String = "sender"
    ): ByteArray = encryptToWirePayload(blockIndex.toLong(), symbolId.toLong(), plaintext, packetTypeCode, flags, direction)
}

package com.lumalink.harness.crypto

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.NoSuchAlgorithmException
import java.security.Security
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Phase 5C.2.0 Crypto Compatibility Spike — JVM Baseline Test.
 *
 * Evaluates JCA primitives, algorithms, providers, and test vectors on the host runtime.
 */
class CryptoCompatibilitySpikeJvmTest {

    companion object {
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

        fun bytesToHex(bytes: ByteArray): String {
            val sb = StringBuilder(bytes.size * 2)
            for (b in bytes) {
                val v = b.toInt() and 0xFF
                if (v < 16) sb.append('0')
                sb.append(Integer.toHexString(v))
            }
            return sb.toString()
        }

        // Canonical Golden Vectors from @lumalink/core/node
        val ALICE_PRIV = hexToBytes("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20")
        val ALICE_PUB = hexToBytes("07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c")
        val BOB_PRIV = hexToBytes("8182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9fa0")
        val BOB_PUB = hexToBytes("883186b800b41d5cf0429695da9b3cc4f328ebcd184a6e482fa578c103f06c77")
        val SHARED_SECRET = hexToBytes("c639664aff13ee2696db677b30b74d56103f38953ef4b5c50b87e2ac31b37367")

        val SESSION_ID_HEX = "09e99973c478442daf602baf76b1d795"
        val SESSION_BYTES = hexToBytes(SESSION_ID_HEX)

        val ENC_KEY = hexToBytes("dc520c4075f7336bba19add48106e7c5842bebf27e279d402f905135411c1657")
        val NONCE_SALT = hexToBytes("10d922")

        val NONCE = hexToBytes("0210d9220000000000000000")
        val AAD = hexToBytes("09e99973c478442daf602baf76b1d79500000000000000000202")

        val PLAINTEXT = hexToBytes("5a5b58595e5f5c5d52535051565754554a4b48494e4f4c4d42434041464744457a7b78797e7f7c7d72737071767774756a6b68696e6f6c6d6263606166676465")
        val CIPHERTEXT = hexToBytes("c13a4d685e8ecb2601828972a12879f2b6d746fd554be3c4bf55eeeefe111b241abd737adb8b4fbeda137fcff164ab7de424e8c307824ce2b5d4461b49e4d96a")
        val TAG = hexToBytes("1935484bafc94cd575abf6609c3976db")

        // Standard ASN.1 DER prefixes for X25519
        val X25519_SPKI_PREFIX = hexToBytes("302a300506032b656e032100")
        val X25519_PKCS8_PREFIX = hexToBytes("302e020100300506032b656e04220420")
    }

    // =========================================================================
    // Experiment A: ChaCha20-Poly1305
    // =========================================================================

    @Test
    fun testChaCha20Poly1305AvailabilityAndVectors() {
        println("=== Experiment A: ChaCha20-Poly1305 ===")
        val cipherNames = listOf("ChaCha20-Poly1305", "ChaCha20/Poly1305/NoPadding")
        var chosenCipher: Cipher? = null
        var chosenName: String? = null

        for (name in cipherNames) {
            try {
                val c = Cipher.getInstance(name)
                chosenCipher = c
                chosenName = name
                println("Found Cipher: $name provided by ${c.provider.name} (v${c.provider.version})")
                break
            } catch (e: NoSuchAlgorithmException) {
                println("Algorithm '$name' not found: ${e.message}")
            }
        }

        assertNotNull("ChaCha20-Poly1305 must be available in JVM", chosenCipher)
        val cipher = chosenCipher!!

        val keySpec = SecretKeySpec(ENC_KEY, "ChaCha20")
        val ivSpec = IvParameterSpec(NONCE)

        // 1. Encryption Test
        cipher.init(Cipher.ENCRYPT_MODE, keySpec, ivSpec)
        cipher.updateAAD(AAD)
        val jcaEncrypted = cipher.doFinal(PLAINTEXT)

        // JCA format is [ciphertext (64 bytes)] || [tag (16 bytes)]
        assertEquals("Total JCA encrypted size must be 80 bytes", 80, jcaEncrypted.size)

        val jcaCiphertext = jcaEncrypted.copyOfRange(0, 64)
        val jcaTag = jcaEncrypted.copyOfRange(64, 80)

        println("JCA Ciphertext: ${bytesToHex(jcaCiphertext)}")
        println("JCA Tag:        ${bytesToHex(jcaTag)}")

        assertArrayEquals("Ciphertext must match canonical TypeScript core", CIPHERTEXT, jcaCiphertext)
        assertArrayEquals("Tag must match canonical TypeScript core", TAG, jcaTag)

        // 2. Wire Format Adaptation: LumaLink wire format is [tag (16B)] || [ciphertext (64B)]
        val wirePayload = ByteArray(80)
        System.arraycopy(TAG, 0, wirePayload, 0, 16)
        System.arraycopy(CIPHERTEXT, 0, wirePayload, 16, 64)

        // Adapt wire payload to JCA format: wire [tag || ciphertext] -> JCA [ciphertext || tag]
        val adaptedForJca = ByteArray(80)
        System.arraycopy(wirePayload, 16, adaptedForJca, 0, 64) // copy ciphertext
        System.arraycopy(wirePayload, 0, adaptedForJca, 64, 16) // copy tag

        // 3. Decryption Test
        val decryptCipher = Cipher.getInstance(chosenName)
        decryptCipher.init(Cipher.DECRYPT_MODE, keySpec, ivSpec)
        decryptCipher.updateAAD(AAD)
        val decryptedPlaintext = decryptCipher.doFinal(adaptedForJca)

        assertArrayEquals("Decrypted plaintext must match original plaintext", PLAINTEXT, decryptedPlaintext)
        println("Decryption successful and verified!")
    }

    // =========================================================================
    // Experiment B: X25519
    // =========================================================================

    @Test
    fun testX25519AvailabilityAndKeyAgreement() {
        println("=== Experiment B: X25519 ===")
        val algNames = listOf("X25519", "XDH")
        var kpg: KeyPairGenerator? = null
        var chosenAlg: String? = null

        for (alg in algNames) {
            try {
                kpg = KeyPairGenerator.getInstance(alg)
                chosenAlg = alg
                println("Found KeyPairGenerator: $alg provided by ${kpg.provider.name}")
                break
            } catch (e: NoSuchAlgorithmException) {
                println("KeyPairGenerator for '$alg' not found")
            }
        }

        assertNotNull("X25519 or XDH KeyPairGenerator must be available", kpg)
        assertNotNull(chosenAlg)

        val ka = KeyAgreement.getInstance(chosenAlg)
        val kf = KeyFactory.getInstance(chosenAlg)

        // Test reconstructing Alice and Bob keys from raw 32 bytes using standard ASN.1 DER wrappers
        val alicePkcs8 = ByteArray(X25519_PKCS8_PREFIX.size + ALICE_PRIV.size)
        System.arraycopy(X25519_PKCS8_PREFIX, 0, alicePkcs8, 0, X25519_PKCS8_PREFIX.size)
        System.arraycopy(ALICE_PRIV, 0, alicePkcs8, X25519_PKCS8_PREFIX.size, ALICE_PRIV.size)
        val alicePrivKey = kf.generatePrivate(PKCS8EncodedKeySpec(alicePkcs8))

        val bobSpki = ByteArray(X25519_SPKI_PREFIX.size + BOB_PUB.size)
        System.arraycopy(X25519_SPKI_PREFIX, 0, bobSpki, 0, X25519_SPKI_PREFIX.size)
        System.arraycopy(BOB_PUB, 0, bobSpki, X25519_SPKI_PREFIX.size, BOB_PUB.size)
        val bobPubKey = kf.generatePublic(X509EncodedKeySpec(bobSpki))

        // Alice computes shared secret with Bob's public key
        ka.init(alicePrivKey)
        ka.doPhase(bobPubKey, true)
        val derivedSecret = ka.generateSecret()

        println("Derived Secret: ${bytesToHex(derivedSecret)}")
        assertArrayEquals("Derived secret must match canonical TypeScript core", SHARED_SECRET, derivedSecret)
    }

    // =========================================================================
    // Experiment C: HKDF & HMAC-SHA256
    // =========================================================================

    @Test
    fun testHmacSha256AndRfc5869Hkdf() {
        println("=== Experiment C: HMAC-SHA256 & HKDF ===")
        val mac = Mac.getInstance("HmacSHA256")
        println("Found Mac: HmacSHA256 provided by ${mac.provider.name}")

        // RFC 5869 HKDF implementation using pure HmacSHA256
        fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
            val m = Mac.getInstance("HmacSHA256")
            m.init(SecretKeySpec(if (key.isNotEmpty()) key else ByteArray(32), "HmacSHA256"))
            return m.doFinal(data)
        }

        fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
            val prk = hmacSha256(salt, ikm)
            var t = ByteArray(0)
            var okm = ByteArray(0)
            var i = 1
            while (okm.size < length) {
                val input = ByteArray(t.size + info.size + 1)
                System.arraycopy(t, 0, input, 0, t.size)
                System.arraycopy(info, 0, input, t.size, info.size)
                input[input.size - 1] = i.toByte()
                t = hmacSha256(prk, input)
                val newOkm = ByteArray(okm.size + t.size)
                System.arraycopy(okm, 0, newOkm, 0, okm.size)
                System.arraycopy(t, 0, newOkm, okm.size, t.size)
                okm = newOkm
                i++
            }
            return okm.copyOf(length)
        }

        val derivedEncKey = hkdf(SHARED_SECRET, SESSION_BYTES, "LumaLink-QuickSend-v2-AEAD-Key".toByteArray(Charsets.UTF_8), 32)
        val derivedNonceSalt = hkdf(SHARED_SECRET, SESSION_BYTES, "LumaLink-QuickSend-v2-Nonce-Salt".toByteArray(Charsets.UTF_8), 3)

        println("Derived EncKey:    ${bytesToHex(derivedEncKey)}")
        println("Derived NonceSalt: ${bytesToHex(derivedNonceSalt)}")

        assertArrayEquals("Derived encryption key must match golden vector", ENC_KEY, derivedEncKey)
        assertArrayEquals("Derived nonce salt must match golden vector", NONCE_SALT, derivedNonceSalt)
    }

    // =========================================================================
    // Experiment E & F: Nonce and AAD Constructions
    // =========================================================================

    @Test
    fun testNonceAndAadConstructions() {
        println("=== Experiment E & F: Nonce and AAD ===")

        // Nonce: [domain=0x02][salt=3B][block=4B BE][symbol=4B BE]
        val constructedNonce = ByteArray(12)
        constructedNonce[0] = 0x02 // sender DATA
        System.arraycopy(NONCE_SALT, 0, constructedNonce, 1, 3)
        val nonceBuf = ByteBuffer.wrap(constructedNonce).order(ByteOrder.BIG_ENDIAN)
        nonceBuf.putInt(4, 0) // blockIndex = 0
        nonceBuf.putInt(8, 0) // symbolId = 0

        assertArrayEquals("Nonce must match canonical vector", NONCE, constructedNonce)

        // AAD: [sessionId=16B][block=4B BE][symbol=4B BE][type=1B][flags=1B]
        val constructedAad = ByteArray(26)
        System.arraycopy(SESSION_BYTES, 0, constructedAad, 0, 16)
        val aadBuf = ByteBuffer.wrap(constructedAad).order(ByteOrder.BIG_ENDIAN)
        aadBuf.putInt(16, 0) // blockIndex = 0
        aadBuf.putInt(20, 0) // symbolId = 0
        constructedAad[24] = 0x02 // packetType = 2 (DATA)
        constructedAad[25] = 0x02 // flags = 2 (FLAG_ENCRYPTED)

        assertArrayEquals("AAD must match canonical vector", AAD, constructedAad)
    }

    @Test
    fun testAndroidCryptoCompatibilityRunnerExecution() {
        println("=== Full AndroidCryptoCompatibilityRunner Execution ===")
        val result = AndroidCryptoCompatibilityRunner.runDiagnostics()
        println(result.report)
        assertTrue("ChaCha20-Poly1305 must succeed on JVM baseline", result.chachaSuccess)
        assertTrue("X25519 must succeed on JVM baseline", result.x25519Success)
        assertTrue("HMAC-SHA256 must succeed on JVM baseline", result.hmacSha256Available)
    }
}

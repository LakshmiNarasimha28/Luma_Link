package com.lumalink.harness.crypto

import android.os.Build
import android.util.Log
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
 * Phase 5C.2.0 — Android Crypto Compatibility Spike Runner.
 *
 * Runs isolated diagnostics on the real Android device (Samsung Galaxy M04 / Android 13)
 * to evaluate native platform JCA support for:
 * 1. ChaCha20-Poly1305 (Cipher, provider, nonce, AAD, tag ordering)
 * 2. X25519 (KeyPairGenerator, KeyAgreement, KeyFactory, raw key exchange)
 * 3. HKDF-SHA256 (direct primitive vs Mac HmacSHA256)
 * 4. Fixed canonical golden vectors from TypeScript core
 */
object AndroidCryptoCompatibilityRunner {

    private const val TAG = "LumaCryptoSpike"

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
    val TAG_BYTES = hexToBytes("1935484bafc94cd575abf6609c3976db")

    // Standard ASN.1 DER prefixes for X25519
    val X25519_SPKI_PREFIX = hexToBytes("302a300506032b656e032100")
    val X25519_PKCS8_PREFIX = hexToBytes("302e020100300506032b656e04220420")

    data class DiagnosticResult(
        val report: String,
        val chachaSuccess: Boolean,
        val chachaProvider: String,
        val chachaTagOrdering: String,
        val x25519Success: Boolean,
        val x25519Provider: String,
        val x25519Error: String?,
        val hkdfDirectAvailable: Boolean,
        val hmacSha256Available: Boolean,
        val platformSufficient: Boolean
    )

    fun runDiagnostics(): DiagnosticResult {
        val out = StringBuilder()
        fun log(msg: String) {
            out.append(msg).append("\n")
            try {
                Log.i(TAG, msg)
            } catch (_: Throwable) {
                // Ignore when executing in pure JVM environment
            }
        }

        val manufacturer = try { Build.MANUFACTURER } catch (_: Throwable) { "JVM/Host" }
        val model = try { Build.MODEL } catch (_: Throwable) { System.getProperty("os.name") ?: "Unknown" }
        val product = try { Build.PRODUCT } catch (_: Throwable) { System.getProperty("os.arch") ?: "Unknown" }
        val release = try { Build.VERSION.RELEASE } catch (_: Throwable) { System.getProperty("java.version") ?: "Unknown" }
        val sdkInt = try { Build.VERSION.SDK_INT } catch (_: Throwable) { 0 }
        val display = try { Build.DISPLAY } catch (_: Throwable) { System.getProperty("java.vm.name") ?: "Unknown" }

        log("============================================================")
        log("LUMALINK PHASE 5C.2.0 CRYPTO COMPATIBILITY SPIKE REPORT")
        log("============================================================")
        log("Device Manufacturer: $manufacturer")
        log("Device Model:        $model")
        log("Device Product:      $product")
        log("Android Version:     $release (API $sdkInt)")
        log("OS Build ID:         $display")
        log("------------------------------------------------------------")

        // 1. Providers Enumeration
        log("\n--- 1. REGISTERED SECURITY PROVIDERS ---")
        val providers = Security.getProviders()
        for ((idx, p) in providers.withIndex()) {
            log("#$idx: ${p.name} (v${p.version}) - ${p.info}")
        }

        // 2. Experiment A: ChaCha20-Poly1305
        log("\n--- 2. EXPERIMENT A: CHACHA20-POLY1305 ---")
        val cipherCandidates = listOf(
            "ChaCha20-Poly1305",
            "ChaCha20/Poly1305/NoPadding",
            "ChaCha20"
        )
        var chachaSuccess = false
        var chachaProvider = "NONE"
        var chachaAlgorithm = "NONE"
        var chachaTagOrdering = "UNKNOWN"

        for (candidate in cipherCandidates) {
            try {
                val cipher = Cipher.getInstance(candidate)
                log("Available: Cipher.getInstance(\"$candidate\") -> Provider: ${cipher.provider.name} (v${cipher.provider.version})")
                if (chachaAlgorithm == "NONE") {
                    chachaAlgorithm = candidate
                    chachaProvider = cipher.provider.name
                }
            } catch (e: Throwable) {
                log("Unavailable: Cipher.getInstance(\"$candidate\") -> ${e.javaClass.simpleName}: ${e.message}")
            }
        }

        if (chachaAlgorithm != "NONE") {
            try {
                val cipher = Cipher.getInstance(chachaAlgorithm)
                val keySpec = SecretKeySpec(ENC_KEY, "ChaCha20")
                val ivSpec = IvParameterSpec(NONCE)

                // Encryption test
                cipher.init(Cipher.ENCRYPT_MODE, keySpec, ivSpec)
                cipher.updateAAD(AAD)
                val jcaEncrypted = cipher.doFinal(PLAINTEXT)

                log("Encryption succeeded: total bytes = ${jcaEncrypted.size}")
                if (jcaEncrypted.size == 80) {
                    val jcaCiphertext = jcaEncrypted.copyOfRange(0, 64)
                    val jcaTag = jcaEncrypted.copyOfRange(64, 80)

                    val ctMatch = jcaCiphertext.contentEquals(CIPHERTEXT)
                    val tagMatch = jcaTag.contentEquals(TAG_BYTES)

                    log("JCA Tag Ordering: [Ciphertext 64B] || [Tag 16B]")
                    log("Ciphertext matches golden vector: $ctMatch")
                    log("Tag matches golden vector:        $tagMatch")

                    if (ctMatch && tagMatch) {
                        chachaTagOrdering = "JCA Appended (Ciphertext || Tag)"

                        // Wire adaptation test: Wire payload is [Tag 16B] || [Ciphertext 64B]
                        val wirePayload = ByteArray(80)
                        System.arraycopy(TAG_BYTES, 0, wirePayload, 0, 16)
                        System.arraycopy(CIPHERTEXT, 0, wirePayload, 16, 64)

                        // Convert wire payload [tag || ciphertext] -> JCA payload [ciphertext || tag]
                        val adaptedForJca = ByteArray(80)
                        System.arraycopy(wirePayload, 16, adaptedForJca, 0, 64)
                        System.arraycopy(wirePayload, 0, adaptedForJca, 64, 16)

                        // Decryption test
                        val decryptCipher = Cipher.getInstance(chachaAlgorithm)
                        decryptCipher.init(Cipher.DECRYPT_MODE, keySpec, ivSpec)
                        decryptCipher.updateAAD(AAD)
                        val decrypted = decryptCipher.doFinal(adaptedForJca)

                        val ptMatch = decrypted.contentEquals(PLAINTEXT)
                        log("Wire payload adapted decryption matches plaintext: $ptMatch")
                        if (ptMatch) {
                            chachaSuccess = true
                        }
                    }
                } else {
                    log("Unexpected JCA encrypted length: ${jcaEncrypted.size} (expected 80)")
                }
            } catch (e: Throwable) {
                log("ChaCha20-Poly1305 execution error: ${e.javaClass.simpleName}: ${e.message}")
            }
        }

        // 3. Experiment B: X25519
        log("\n--- 3. EXPERIMENT B: X25519 ---")
        val x25519Candidates = listOf("X25519", "XDH", "1.3.101.110")
        var x25519Success = false
        var x25519Provider = "NONE"
        var x25519Algorithm = "NONE"
        var x25519Error: String? = null

        for (candidate in x25519Candidates) {
            try {
                val kpg = KeyPairGenerator.getInstance(candidate)
                log("Available: KeyPairGenerator.getInstance(\"$candidate\") -> Provider: ${kpg.provider.name}")
                if (x25519Algorithm == "NONE") {
                    x25519Algorithm = candidate
                    x25519Provider = kpg.provider.name
                }
            } catch (e: Throwable) {
                log("Unavailable: KeyPairGenerator.getInstance(\"$candidate\") -> ${e.javaClass.simpleName}: ${e.message}")
            }
        }

        if (x25519Algorithm != "NONE") {
            try {
                val kpg = KeyPairGenerator.getInstance(x25519Algorithm)
                val ka = KeyAgreement.getInstance(x25519Algorithm)
                val kf = KeyFactory.getInstance(x25519Algorithm)

                // Test dynamic key pair generation
                val kpA = kpg.generateKeyPair()
                val kpB = kpg.generateKeyPair()

                ka.init(kpA.private)
                ka.doPhase(kpB.public, true)
                val dynamicSecretA = ka.generateSecret()

                ka.init(kpB.private)
                ka.doPhase(kpA.public, true)
                val dynamicSecretB = ka.generateSecret()

                val dynamicEqual = dynamicSecretA.contentEquals(dynamicSecretB)
                log("Dynamic X25519 key agreement Alice->Bob == Bob->Alice: $dynamicEqual")

                // Test raw 32-byte key import using standard ASN.1 DER wrappers
                val alicePkcs8 = ByteArray(X25519_PKCS8_PREFIX.size + ALICE_PRIV.size)
                System.arraycopy(X25519_PKCS8_PREFIX, 0, alicePkcs8, 0, X25519_PKCS8_PREFIX.size)
                System.arraycopy(ALICE_PRIV, 0, alicePkcs8, X25519_PKCS8_PREFIX.size, ALICE_PRIV.size)
                val alicePrivKey = kf.generatePrivate(PKCS8EncodedKeySpec(alicePkcs8))

                val bobSpki = ByteArray(X25519_SPKI_PREFIX.size + BOB_PUB.size)
                System.arraycopy(X25519_SPKI_PREFIX, 0, bobSpki, 0, X25519_SPKI_PREFIX.size)
                System.arraycopy(BOB_PUB, 0, bobSpki, X25519_SPKI_PREFIX.size, BOB_PUB.size)
                val bobPubKey = kf.generatePublic(X509EncodedKeySpec(bobSpki))

                ka.init(alicePrivKey)
                ka.doPhase(bobPubKey, true)
                val derivedSecret = ka.generateSecret()

                val vectorEqual = derivedSecret.contentEquals(SHARED_SECRET)
                log("Fixed X25519 vector derived secret matches canonical core: $vectorEqual")
                log("Derived secret: ${bytesToHex(derivedSecret)}")

                if (vectorEqual) {
                    x25519Success = true
                }
            } catch (e: Throwable) {
                x25519Error = "${e.javaClass.simpleName}: ${e.message}"
                log("X25519 operation failed: $x25519Error")
            }
        } else {
            x25519Error = "NoSuchAlgorithmException: No X25519/XDH KeyPairGenerator on platform"
            log("X25519 NOT SUPPORTED by platform JCA providers!")
        }

        // 4. Experiment C: HKDF & HMAC-SHA256
        log("\n--- 4. EXPERIMENT C: HKDF & HMAC-SHA256 ---")
        var hkdfDirectAvailable = false
        val hkdfCandidates = listOf("HKDF", "HKDF-SHA256", "HkdfSHA256")
        for (candidate in hkdfCandidates) {
            try {
                val mac = Mac.getInstance(candidate)
                log("Direct HKDF available via Mac: $candidate -> ${mac.provider.name}")
                hkdfDirectAvailable = true
            } catch (e: Throwable) {
                // expected
            }
        }
        if (!hkdfDirectAvailable) {
            log("Direct HKDF primitive: NOT available as standalone JCA service")
        }

        var hmacSha256Available = false
        var hmacProvider = "NONE"
        try {
            val mac = Mac.getInstance("HmacSHA256")
            hmacSha256Available = true
            hmacProvider = mac.provider.name
            log("HmacSHA256 available: YES -> Provider: $hmacProvider (v${mac.provider.version})")

            // Test RFC 5869 HKDF using pure HmacSHA256
            fun hmac(key: ByteArray, data: ByteArray): ByteArray {
                val m = Mac.getInstance("HmacSHA256")
                m.init(SecretKeySpec(if (key.isNotEmpty()) key else ByteArray(32), "HmacSHA256"))
                return m.doFinal(data)
            }
            fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, len: Int): ByteArray {
                val prk = hmac(salt, ikm)
                var t = ByteArray(0)
                var okm = ByteArray(0)
                var i = 1
                while (okm.size < len) {
                    val inp = ByteArray(t.size + info.size + 1)
                    System.arraycopy(t, 0, inp, 0, t.size)
                    System.arraycopy(info, 0, inp, t.size, info.size)
                    inp[inp.size - 1] = i.toByte()
                    t = hmac(prk, inp)
                    val newOkm = ByteArray(okm.size + t.size)
                    System.arraycopy(okm, 0, newOkm, 0, okm.size)
                    System.arraycopy(t, 0, newOkm, okm.size, t.size)
                    okm = newOkm
                    i++
                }
                return okm.copyOf(len)
            }

            val derivedK1 = hkdf(SHARED_SECRET, SESSION_BYTES, "LumaLink-QuickSend-v2-AEAD-Key".toByteArray(Charsets.UTF_8), 32)
            val derivedK2 = hkdf(SHARED_SECRET, SESSION_BYTES, "LumaLink-QuickSend-v2-Nonce-Salt".toByteArray(Charsets.UTF_8), 3)

            val k1Match = derivedK1.contentEquals(ENC_KEY)
            val k2Match = derivedK2.contentEquals(NONCE_SALT)

            log("RFC 5869 HKDF-Expand-32 (encKey) matches:    $k1Match")
            log("RFC 5869 HKDF-Expand-3 (nonceSalt) matches: $k2Match")
        } catch (e: Throwable) {
            log("HmacSHA256 failed: ${e.javaClass.simpleName}: ${e.message}")
        }

        // 5. Experiment E & F: Nonce & AAD Vectors
        log("\n--- 5. EXPERIMENT E & F: NONCE & AAD VECTORS ---")
        val constructedNonce = ByteArray(12)
        constructedNonce[0] = 0x02
        System.arraycopy(NONCE_SALT, 0, constructedNonce, 1, 3)
        val nonceBuf = ByteBuffer.wrap(constructedNonce).order(ByteOrder.BIG_ENDIAN)
        nonceBuf.putInt(4, 0)
        nonceBuf.putInt(8, 0)
        val nonceMatch = constructedNonce.contentEquals(NONCE)
        log("Constructed 12-byte nonce matches golden vector: $nonceMatch")

        val constructedAad = ByteArray(26)
        System.arraycopy(SESSION_BYTES, 0, constructedAad, 0, 16)
        val aadBuf = ByteBuffer.wrap(constructedAad).order(ByteOrder.BIG_ENDIAN)
        aadBuf.putInt(16, 0)
        aadBuf.putInt(20, 0)
        constructedAad[24] = 0x02
        constructedAad[25] = 0x02
        val aadMatch = constructedAad.contentEquals(AAD)
        log("Constructed 26-byte AAD matches golden vector:   $aadMatch")

        // 6. Summary Assessment
        log("\n--- 6. SUMMARY ASSESSMENT ---")
        val platformSufficient = chachaSuccess && x25519Success && hmacSha256Available
        log("ChaCha20-Poly1305 Supported: $chachaSuccess ($chachaProvider)")
        log("X25519 Supported:            $x25519Success ($x25519Provider)")
        log("HMAC-SHA256 Supported:       $hmacSha256Available ($hmacProvider)")
        log("Platform Crypto Sufficient:  $platformSufficient")

        val reportStr = out.toString()

        return DiagnosticResult(
            report = reportStr,
            chachaSuccess = chachaSuccess,
            chachaProvider = chachaProvider,
            chachaTagOrdering = chachaTagOrdering,
            x25519Success = x25519Success,
            x25519Provider = x25519Provider,
            x25519Error = x25519Error,
            hkdfDirectAvailable = hkdfDirectAvailable,
            hmacSha256Available = hmacSha256Available,
            platformSufficient = platformSufficient
        )
    }
}

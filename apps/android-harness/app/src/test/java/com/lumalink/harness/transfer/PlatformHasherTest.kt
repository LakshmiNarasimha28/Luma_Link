package com.lumalink.harness.transfer

import org.junit.Assert.assertEquals
import org.junit.Test
import java.nio.charset.StandardCharsets

/**
 * Unit tests verifying PlatformHasher conforms strictly to FIPS 180-4 SHA-256 standard
 * and matches the canonical TypeScript PortableHasher and Node crypto reference vectors.
 */
class PlatformHasherTest {

    private val hasher = PlatformHasher()

    @Test
    fun testNistEmptyString() {
        val empty = ByteArray(0)
        val expected = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        val actual = hasher.hashSha256(empty)
        assertEquals(expected, actual)
    }

    @Test
    fun testNistAbc() {
        val data = "abc".toByteArray(StandardCharsets.UTF_8)
        val expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        val actual = hasher.hashSha256(data)
        assertEquals(expected, actual)
    }

    @Test
    fun testNist56ByteMultiBlockBoundary() {
        val str = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
        val data = str.toByteArray(StandardCharsets.UTF_8)
        val expected = "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        val actual = hasher.hashSha256(data)
        assertEquals(expected, actual)
    }

    @Test
    fun testGoldenVectorsMatchCanonicalReference() {
        // 1. Single block 1024B
        val data1024 = ByteArray(1024) { i -> (((i + 1) * 7) and 0xFF).toByte() }
        assertEquals(
            "6d08077b4795f29ba27c3f7802ba28d26bf8cc55f8b60e6081bbda4e15c7760f",
            hasher.hashSha256(data1024)
        )

        // 2. Partial block 1000B
        val data1000 = data1024.copyOfRange(0, 1000)
        assertEquals(
            "0acbc8420eff771695d4a31a478b8f1627d54f8718aa6904cd4895d7eb92b7b7",
            hasher.hashSha256(data1000)
        )

        // 3. Multi-block 2500B
        val data2500 = ByteArray(2500) { i -> ((i * 13 + 37) and 0xFF).toByte() }
        assertEquals(
            "0ed48e0f1222e6cdbb46abb0be800ab6c14dfc25a1d4342bb7a750ac4a1ed710",
            hasher.hashSha256(data2500)
        )
    }

    @Test
    fun testDigestFormatIs64LowercaseHexChars() {
        val data = "LumaLink Optical Transfer Protocol".toByteArray(StandardCharsets.UTF_8)
        val digest = hasher.hashSha256(data)
        assertEquals(64, digest.length)
        val isLowerHex = digest.all { (it in '0'..'9') || (it in 'a'..'f') }
        assert(isLowerHex) { "Digest contains non-lowercase-hex characters: $digest" }
    }
}

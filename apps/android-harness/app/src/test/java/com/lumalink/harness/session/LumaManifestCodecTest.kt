package com.lumalink.harness.session

import org.junit.Assert.*
import org.junit.Test

/**
 * Unit tests for [LumaManifestCodec].
 *
 * Verifies byte-level parity with TypeScript canonical [ManifestCodec].
 */
class LumaManifestCodecTest {

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

        const val GOLDEN_HEX =
            "0101000009e99973c478442daf602baf76b1d795000001925bfa8e000000000000000400000000010040001007a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c6d08077b4795f29ba27c3f7802ba28d26bf8cc55f8b60e6081bbda4e15c7760f1273656e6465722d746573742d6465762d3031000d746573742d66696c652e62696e"

        val GOLDEN_SESSION_ID = hexToBytes("09e99973c478442daf602baf76b1d795")
        val GOLDEN_PUB_KEY = hexToBytes("07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c")
        const val GOLDEN_SHA256 = "6d08077b4795f29ba27c3f7802ba28d26bf8cc55f8b60e6081bbda4e15c7760f"

        val GOLDEN_ANNOUNCEMENT = LumaSessionAnnouncement(
            sessionId = GOLDEN_SESSION_ID,
            mode = "quick",
            senderDeviceId = "sender-test-dev-01",
            senderPublicKey = GOLDEN_PUB_KEY,
            fileName = "test-file.bin",
            fileSize = 1024L,
            sha256Digest = GOLDEN_SHA256,
            symbolSize = 64,
            symbolsPerBlock = 16,
            totalBlocks = 1,
            timestamp = 1728120000000L
        )
    }

    @Test
    fun testGoldenVectorEncodeMatchesCanonicalHex() {
        val encoded = LumaManifestCodec.encode(GOLDEN_ANNOUNCEMENT)
        assertEquals(142, encoded.size)
        assertEquals(GOLDEN_HEX, bytesToHex(encoded))
    }

    @Test
    fun testGoldenVectorDecodeMatchesCanonicalAnnouncement() {
        val raw = hexToBytes(GOLDEN_HEX)
        val decoded = LumaManifestCodec.decode(raw)

        assertArrayEquals(GOLDEN_SESSION_ID, decoded.sessionId)
        assertEquals("quick", decoded.mode)
        assertEquals("sender-test-dev-01", decoded.senderDeviceId)
        assertArrayEquals(GOLDEN_PUB_KEY, decoded.senderPublicKey)
        assertEquals("test-file.bin", decoded.fileName)
        assertEquals(1024L, decoded.fileSize)
        assertEquals(GOLDEN_SHA256, decoded.sha256Digest)
        assertEquals(64, decoded.symbolSize)
        assertEquals(16, decoded.symbolsPerBlock)
        assertEquals(1, decoded.totalBlocks)
        assertEquals(1728120000000L, decoded.timestamp)
    }

    @Test
    fun testToFileManifestConversion() {
        val manifest = GOLDEN_ANNOUNCEMENT.toFileManifest()
        assertArrayEquals(GOLDEN_SESSION_ID, manifest.sessionId)
        assertEquals("test-file.bin", manifest.fileName)
        assertEquals(1024L, manifest.fileSize)
        assertEquals(GOLDEN_SHA256, manifest.sha256Digest)
        assertEquals(64, manifest.symbolSize)
        assertEquals(16, manifest.symbolsPerBlock)
        assertEquals(1, manifest.totalBlocks)
        assertEquals("application/octet-stream", manifest.mimeType)
    }

    @Test
    fun testPrivateSendMode() {
        val privateAnnouncement = GOLDEN_ANNOUNCEMENT.copy(mode = "private")
        val encoded = LumaManifestCodec.encode(privateAnnouncement)
        assertEquals(2, encoded[1].toInt() and 0xFF)

        val decoded = LumaManifestCodec.decode(encoded)
        assertEquals("private", decoded.mode)
    }

    @Test
    fun testEmptySenderDeviceIdAndUtf8FileName() {
        val announcement = GOLDEN_ANNOUNCEMENT.copy(
            senderDeviceId = "",
            fileName = "föö-bår-🚀.bin"
        )
        val encoded = LumaManifestCodec.encode(announcement)
        assertEquals(0, encoded[108].toInt() and 0xFF)

        val decoded = LumaManifestCodec.decode(encoded)
        assertEquals("", decoded.senderDeviceId)
        assertEquals("föö-bår-🚀.bin", decoded.fileName)
    }

    @Test
    fun testBoundaryStringLengths() {
        val maxDeviceId = "d".repeat(64)
        val maxFileName = "f".repeat(255)
        val boundaryAnnouncement = GOLDEN_ANNOUNCEMENT.copy(
            senderDeviceId = maxDeviceId,
            fileName = maxFileName
        )

        val encoded = LumaManifestCodec.encode(boundaryAnnouncement)
        assertEquals(430, encoded.size) // 111 + 64 + 255 = 430

        val decoded = LumaManifestCodec.decode(encoded)
        assertEquals(maxDeviceId, decoded.senderDeviceId)
        assertEquals(maxFileName, decoded.fileName)
    }

    @Test
    fun testLargeFileSizeGreaterThan4Gb() {
        val largeSize = 10L * 1024 * 1024 * 1024 // 10 GB
        val announcement = GOLDEN_ANNOUNCEMENT.copy(
            fileSize = largeSize,
            totalBlocks = 10000
        )
        val encoded = LumaManifestCodec.encode(announcement)
        val decoded = LumaManifestCodec.decode(encoded)
        assertEquals(largeSize, decoded.fileSize)
        assertEquals(10000, decoded.totalBlocks)
    }

    @Test
    fun testTruncatedBufferRejection() {
        val encoded = LumaManifestCodec.encode(GOLDEN_ANNOUNCEMENT)

        assertThrows(TruncatedManifestException::class.java) {
            LumaManifestCodec.decode(ByteArray(0))
        }
        assertThrows(TruncatedManifestException::class.java) {
            LumaManifestCodec.decode(encoded.copyOfRange(0, 50))
        }
        assertThrows(TruncatedManifestException::class.java) {
            LumaManifestCodec.decode(encoded.copyOfRange(0, 110))
        }
        assertThrows(TruncatedManifestException::class.java) {
            LumaManifestCodec.decode(encoded.copyOfRange(0, 115))
        }
        assertThrows(TruncatedManifestException::class.java) {
            LumaManifestCodec.decode(encoded.copyOfRange(0, encoded.size - 1))
        }
    }

    @Test
    fun testTrailingDataRejection() {
        val encoded = LumaManifestCodec.encode(GOLDEN_ANNOUNCEMENT)
        val withTrailing = encoded + byteArrayOf(0xDE.toByte(), 0xAD.toByte(), 0xBE.toByte(), 0xEF.toByte())

        assertThrows(TrailingDataManifestException::class.java) {
            LumaManifestCodec.decode(withTrailing)
        }
    }

    @Test
    fun testUnsupportedVersionRejection() {
        val encoded = LumaManifestCodec.encode(GOLDEN_ANNOUNCEMENT)
        encoded[0] = 2 // Version 2
        assertThrows(UnsupportedManifestVersionException::class.java) {
            LumaManifestCodec.decode(encoded)
        }

        encoded[0] = 0 // Version 0
        assertThrows(UnsupportedManifestVersionException::class.java) {
            LumaManifestCodec.decode(encoded)
        }
    }

    @Test
    fun testInvalidSecurityModeRejection() {
        val encoded = LumaManifestCodec.encode(GOLDEN_ANNOUNCEMENT)
        encoded[1] = 0
        assertThrows(InvalidManifestFieldException::class.java) {
            LumaManifestCodec.decode(encoded)
        }

        encoded[1] = 3
        assertThrows(InvalidManifestFieldException::class.java) {
            LumaManifestCodec.decode(encoded)
        }
    }

    @Test
    fun testNonZeroReservedFieldRejection() {
        val encoded = LumaManifestCodec.encode(GOLDEN_ANNOUNCEMENT)
        encoded[2] = 0x01
        assertThrows(MalformedManifestException::class.java) {
            LumaManifestCodec.decode(encoded)
        }
    }

    @Test
    fun testEncodeValidationFailures() {
        // Data model construction validation (require)
        assertThrows(IllegalArgumentException::class.java) {
            GOLDEN_ANNOUNCEMENT.copy(fileSize = -1L)
        }
        assertThrows(IllegalArgumentException::class.java) {
            GOLDEN_ANNOUNCEMENT.copy(totalBlocks = 0)
        }
        assertThrows(IllegalArgumentException::class.java) {
            GOLDEN_ANNOUNCEMENT.copy(symbolSize = 0)
        }
        assertThrows(IllegalArgumentException::class.java) {
            GOLDEN_ANNOUNCEMENT.copy(symbolsPerBlock = 0)
        }
        assertThrows(IllegalArgumentException::class.java) {
            GOLDEN_ANNOUNCEMENT.copy(senderPublicKey = ByteArray(16))
        }
        assertThrows(IllegalArgumentException::class.java) {
            GOLDEN_ANNOUNCEMENT.copy(sessionId = ByteArray(12))
        }
        assertThrows(IllegalArgumentException::class.java) {
            GOLDEN_ANNOUNCEMENT.copy(sha256Digest = "short")
        }

        // Codec-specific encode string bounds validation
        assertThrows(InvalidManifestFieldException::class.java) {
            LumaManifestCodec.encode(GOLDEN_ANNOUNCEMENT.copy(senderDeviceId = "x".repeat(65)))
        }
        assertThrows(InvalidManifestFieldException::class.java) {
            LumaManifestCodec.encode(GOLDEN_ANNOUNCEMENT.copy(fileName = ""))
        }
        assertThrows(InvalidManifestFieldException::class.java) {
            LumaManifestCodec.encode(GOLDEN_ANNOUNCEMENT.copy(fileName = "x".repeat(256)))
        }
    }

    @Test
    fun testMalformedUtf8Rejection() {
        val encoded = LumaManifestCodec.encode(GOLDEN_ANNOUNCEMENT)
        // Offset 129 is the start of 'test-file.bin'. 0xFF is invalid in UTF-8
        encoded[129] = 0xFF.toByte()

        assertThrows(MalformedManifestException::class.java) {
            LumaManifestCodec.decode(encoded)
        }
    }
}

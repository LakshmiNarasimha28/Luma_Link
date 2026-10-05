package com.lumalink.harness.transfer

import com.lumalink.harness.crypto.TestFixtureSessions
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Unit tests verifying LumaFileReassembler:
 * - exact block boundary handling
 * - partial final block padding trimming
 * - multi-block ordering
 * - out-of-order block arrivals
 * - duplicate block additions
 * - missing block detection
 * - SHA-256 verification and corruption detection
 */
class LumaFileReassemblerTest {

    private val sessionId = TestFixtureSessions.GOLDEN_SESSION_ID_BYTES

    @Test
    fun testEmptyFileReassembly() {
        val manifest = LumaFileManifest(
            sessionId = sessionId,
            fileName = "empty.bin",
            fileSize = 0L,
            sha256Digest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            symbolSize = 64,
            symbolsPerBlock = 1,
            totalBlocks = 1
        )
        val reassembler = LumaFileReassembler(manifest)
        // In empty file, 1 zero-padded symbol is transmitted
        reassembler.addBlock(0L, ByteArray(64))

        assertTrue(reassembler.isComplete())
        val result = reassembler.reassemble()
        assertTrue(result.success)
        assertTrue(result.verifiedSha256)
        assertEquals(0, result.fileBytes.size)
        assertEquals(manifest.sha256Digest, result.sha256Digest)
    }

    @Test
    fun testEmptyFileWithCorruptedHashThrows() {
        val manifest = LumaFileManifest(
            sessionId = sessionId,
            fileName = "empty.bin",
            fileSize = 0L,
            sha256Digest = "0000000000000000000000000000000000000000000000000000000000000000",
            symbolSize = 64,
            symbolsPerBlock = 1,
            totalBlocks = 1
        )
        val reassembler = LumaFileReassembler(manifest)
        reassembler.addBlock(0L, ByteArray(64))

        try {
            reassembler.reassemble()
            fail("Expected Sha256MismatchException")
        } catch (e: Sha256MismatchException) {
            assertEquals(manifest.sha256Digest, e.expected)
            assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", e.actual)
        }
    }

    @Test
    fun testSingleBlockExactBoundary() {
        val manifest = TestFixtureSessions.GOLDEN_MANIFEST_1024B
        val reassembler = LumaFileReassembler(manifest)

        val sourceData = ByteArray(1024) { i -> (((i + 1) * 7) and 0xFF).toByte() }
        reassembler.addBlock(0L, sourceData)

        assertTrue(reassembler.isComplete())
        val result = reassembler.reassemble()
        assertTrue(result.success)
        assertTrue(result.verifiedSha256)
        assertEquals(1024, result.fileBytes.size)
        assertArrayEquals(sourceData, result.fileBytes)
        assertEquals(manifest.sha256Digest, result.sha256Digest)
    }

    @Test
    fun testSingleBlockPartialWithPaddingTrimming() {
        val manifest = TestFixtureSessions.GOLDEN_MANIFEST_1000B
        val reassembler = LumaFileReassembler(manifest)

        val fullSource = ByteArray(1024) { i -> (((i + 1) * 7) and 0xFF).toByte() }
        // 1000 bytes file payload + 24 zero padding bytes in block
        val blockData = ByteArray(1024)
        System.arraycopy(fullSource, 0, blockData, 0, 1000)

        reassembler.addBlock(0L, blockData)

        assertTrue(reassembler.isComplete())
        val result = reassembler.reassemble()
        assertTrue(result.success)
        assertTrue(result.verifiedSha256)
        assertEquals(1000, result.fileBytes.size)
        val expectedBytes = fullSource.copyOfRange(0, 1000)
        assertArrayEquals(expectedBytes, result.fileBytes)
        assertEquals(manifest.sha256Digest, result.sha256Digest)
    }

    @Test
    fun testMultiBlockTransferWithPaddingTrimming() {
        val manifest = TestFixtureSessions.GOLDEN_MANIFEST_2500B
        val reassembler = LumaFileReassembler(manifest)

        val fullFile = ByteArray(2500) { i -> ((i * 13 + 37) and 0xFF).toByte() }

        // Block 0: 1024 bytes (0 .. 1023)
        val block0 = fullFile.copyOfRange(0, 1024)
        // Block 1: 1024 bytes (1024 .. 2047)
        val block1 = fullFile.copyOfRange(1024, 2048)
        // Block 2: 452 bytes (2048 .. 2499) + 572 zero padding bytes = 1024 bytes
        val block2 = ByteArray(1024)
        System.arraycopy(fullFile, 2048, block2, 0, 452)

        reassembler.addBlock(0L, block0)
        reassembler.addBlock(1L, block1)
        reassembler.addBlock(2L, block2)

        assertTrue(reassembler.isComplete())
        val result = reassembler.reassemble()
        assertTrue(result.success)
        assertTrue(result.verifiedSha256)
        assertEquals(2500, result.fileBytes.size)
        assertArrayEquals(fullFile, result.fileBytes)
        assertEquals(manifest.sha256Digest, result.sha256Digest)
    }

    @Test
    fun testOutOfOrderBlockArrival() {
        val manifest = TestFixtureSessions.GOLDEN_MANIFEST_2500B
        val reassembler = LumaFileReassembler(manifest)

        val fullFile = ByteArray(2500) { i -> ((i * 13 + 37) and 0xFF).toByte() }
        val block0 = fullFile.copyOfRange(0, 1024)
        val block1 = fullFile.copyOfRange(1024, 2048)
        val block2 = ByteArray(1024).apply {
            System.arraycopy(fullFile, 2048, this, 0, 452)
        }

        // Add blocks in reversed order: 2, 0, 1
        reassembler.addBlock(2L, block2)
        assertFalse(reassembler.isComplete())
        assertEquals(listOf(0L, 1L), reassembler.getMissingBlocks())

        reassembler.addBlock(0L, block0)
        assertFalse(reassembler.isComplete())
        assertEquals(listOf(1L), reassembler.getMissingBlocks())

        reassembler.addBlock(1L, block1)
        assertTrue(reassembler.isComplete())
        assertTrue(reassembler.getMissingBlocks().isEmpty())

        val result = reassembler.reassemble()
        assertTrue(result.success)
        assertArrayEquals(fullFile, result.fileBytes)
    }

    @Test
    fun testDuplicateBlockAdditionIsIdempotent() {
        val manifest = TestFixtureSessions.GOLDEN_MANIFEST_1024B
        val reassembler = LumaFileReassembler(manifest)
        val sourceData = ByteArray(1024) { i -> (((i + 1) * 7) and 0xFF).toByte() }

        reassembler.addBlock(0L, sourceData)
        reassembler.addBlock(0L, sourceData) // Duplicate addition

        assertEquals(1, reassembler.getReceivedBlockCount())
        val result = reassembler.reassemble()
        assertTrue(result.success)
        assertArrayEquals(sourceData, result.fileBytes)
    }

    @Test
    fun testMissingBlockThrowsIncompleteTransferException() {
        val manifest = TestFixtureSessions.GOLDEN_MANIFEST_2500B
        val reassembler = LumaFileReassembler(manifest)

        val dummyBlock = ByteArray(1024)
        reassembler.addBlock(0L, dummyBlock)
        reassembler.addBlock(2L, dummyBlock) // Omit block 1

        assertFalse(reassembler.isComplete())
        assertEquals(listOf(1L), reassembler.getMissingBlocks())

        try {
            reassembler.reassemble()
            fail("Expected IncompleteTransferException")
        } catch (e: IncompleteTransferException) {
            assertEquals(listOf(1L), e.missingBlocks)
        }
    }

    @Test
    fun testCorruptedDataThrowsSha256MismatchException() {
        val manifest = TestFixtureSessions.GOLDEN_MANIFEST_1024B
        val reassembler = LumaFileReassembler(manifest)

        val corruptedData = ByteArray(1024) { i -> (((i + 1) * 7) and 0xFF).toByte() }
        corruptedData[0] = (corruptedData[0].toInt() xor 0xFF).toByte() // Corrupt first byte

        reassembler.addBlock(0L, corruptedData)
        assertTrue(reassembler.isComplete())

        try {
            reassembler.reassemble()
            fail("Expected Sha256MismatchException")
        } catch (e: Sha256MismatchException) {
            assertEquals(manifest.sha256Digest, e.expected)
            assertFalse(e.expected.equals(e.actual, ignoreCase = true))
        }
    }

    @Test
    fun testInvalidBlockIndexThrows() {
        val manifest = TestFixtureSessions.GOLDEN_MANIFEST_1024B
        val reassembler = LumaFileReassembler(manifest)

        try {
            reassembler.addBlock(-1L, ByteArray(1024))
            fail("Expected IllegalArgumentException for blockIndex -1")
        } catch (e: IllegalArgumentException) {
            // expected
        }

        try {
            reassembler.addBlock(1L, ByteArray(1024))
            fail("Expected IllegalArgumentException for blockIndex 1 on 1-block manifest")
        } catch (e: IllegalArgumentException) {
            // expected
        }
    }
}

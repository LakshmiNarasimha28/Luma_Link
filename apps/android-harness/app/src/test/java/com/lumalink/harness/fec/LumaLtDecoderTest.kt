package com.lumalink.harness.fec

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for LumaLtDecoder multi-block manager.
 */
class LumaLtDecoderTest {

    @Test
    fun testMultiBlockIsolation() {
        val decoder = LumaLtDecoder(defaultSymbolSize = 16)
        val k = 2

        val block0Sym0 = ByteArray(16) { 0x11 }
        val block0Sym1 = ByteArray(16) { 0x22 }
        val block1Sym0 = ByteArray(16) { 0x33 }
        val block1Sym1 = ByteArray(16) { 0x44 }

        // Feed block 0 symbols
        val b0 = decoder.registerBlock(blockIndex = 0L, k = k, symbolSize = 16)
        b0.addSymbol(symbolId = 10L, data = block0Sym0, packetDegree = 1, neighbors = listOf(0))
        b0.addSymbol(symbolId = 11L, data = block0Sym1, packetDegree = 1, neighbors = listOf(1))

        // Feed only 1 symbol to block 1
        val b1 = decoder.registerBlock(blockIndex = 1L, k = k, symbolSize = 16)
        b1.addSymbol(symbolId = 20L, data = block1Sym0, packetDegree = 1, neighbors = listOf(0))

        assertTrue(decoder.isBlockComplete(0L))
        assertFalse(decoder.isBlockComplete(1L))

        assertEquals(DecoderStatus.COMPLETE, decoder.getBlockStatus(0L))
        assertEquals(DecoderStatus.STALLED, decoder.getBlockStatus(1L))

        val rec0 = decoder.reconstructBlock(0L)
        assertNotNull(rec0)
        assertEquals(32, rec0!!.size)

        val rec1 = decoder.reconstructBlock(1L)
        assertNull(rec1)
    }

    @Test
    fun testAutoBlockRegistrationOnAddSymbol() {
        val decoder = LumaLtDecoder(defaultSymbolSize = 64)
        val data = ByteArray(64) { 0x5A }

        // addSymbol should automatically instantiate BlockDecoder for block 0 (degree 1)
        val useful = decoder.addSymbol(
            blockIndex = 0L,
            symbolId = 0L,
            k = 16,
            data = data,
            degree = 1
        )

        assertTrue(useful)
        assertNotNull(decoder.getBlockDecoder(0L))
        assertEquals(1, decoder.getBlockDecoder(0L)?.recoveredSymbolCount)
    }

    @Test
    fun testResetClearsDecoders() {
        val decoder = LumaLtDecoder(defaultSymbolSize = 16)
        decoder.registerBlock(0L, 4, 16)
        assertNotNull(decoder.getBlockDecoder(0L))

        decoder.reset()
        assertNull(decoder.getBlockDecoder(0L))
        assertFalse(decoder.isBlockComplete(0L))
    }
}

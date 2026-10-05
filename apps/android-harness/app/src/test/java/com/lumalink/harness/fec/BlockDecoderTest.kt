package com.lumalink.harness.fec

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests verifying BlockDecoder peeling logic, duplicate rejection,
 * ripple propagation, stalled status, and reconstruction.
 */
class BlockDecoderTest {

    private val symbolSize = 16
    private val k = 8

    private fun createTestSourceBlock(): Pair<ByteArray, List<ByteArray>> {
        val raw = ByteArray(k * symbolSize) { i -> (((i + 1) * 3) and 0xFF).toByte() }
        val symbols = List(k) { i ->
            val start = i * symbolSize
            raw.copyOfRange(start, start + symbolSize)
        }
        return Pair(raw, symbols)
    }

    private fun encodeSymbol(
        sourceSymbols: List<ByteArray>,
        neighbors: List<Int>
    ): ByteArray {
        val data = ByteArray(symbolSize)
        for (n in neighbors) {
            val src = sourceSymbols[n]
            for (b in 0 until symbolSize) {
                data[b] = (data[b].toInt() xor src[b].toInt()).toByte()
            }
        }
        return data
    }

    @Test
    fun testDegreeOneDirectRecovery() {
        val (raw, sourceSymbols) = createTestSourceBlock()
        val decoder = BlockDecoder(blockIndex = 0L, k = k, symbolSize = symbolSize)

        // Feed degree-1 symbol for neighbor 3
        val symData = sourceSymbols[3]
        val useful = decoder.addSymbol(
            symbolId = 100L,
            data = symData,
            packetDegree = 1,
            neighbors = listOf(3)
        )

        assertTrue(useful)
        assertEquals(1, decoder.recoveredSymbolCount)
        assertFalse(decoder.isComplete())
        assertNull(decoder.reconstruct())
    }

    @Test
    fun testRipplePropagation() {
        val (raw, sourceSymbols) = createTestSourceBlock()
        val decoder = BlockDecoder(blockIndex = 0L, k = k, symbolSize = symbolSize)

        // 1. Add degree-2 equation: neighbors [0, 1] -> cannot solve yet
        val eq01 = encodeSymbol(sourceSymbols, listOf(0, 1))
        val useful1 = decoder.addSymbol(
            symbolId = 1L,
            data = eq01,
            packetDegree = 2,
            neighbors = listOf(0, 1)
        )
        assertTrue(useful1)
        assertEquals(0, decoder.recoveredSymbolCount)
        assertEquals(DecoderStatus.STALLED, decoder.getStatus())

        // 2. Add degree-1 equation: neighbor [0] -> solves 0, ripples to solve 1!
        val eq0 = sourceSymbols[0]
        val useful2 = decoder.addSymbol(
            symbolId = 2L,
            data = eq0,
            packetDegree = 1,
            neighbors = listOf(0)
        )
        assertTrue(useful2)
        assertEquals(2, decoder.recoveredSymbolCount) // Both 0 and 1 solved!
    }

    @Test
    fun testDuplicateSymbolRejection() {
        val (raw, sourceSymbols) = createTestSourceBlock()
        val decoder = BlockDecoder(blockIndex = 0L, k = k, symbolSize = symbolSize)

        val symData = sourceSymbols[2]
        val firstArrival = decoder.addSymbol(
            symbolId = 42L,
            data = symData,
            packetDegree = 1,
            neighbors = listOf(2)
        )
        assertTrue(firstArrival)

        val secondArrival = decoder.addSymbol(
            symbolId = 42L, // Same symbol ID
            data = symData,
            packetDegree = 1,
            neighbors = listOf(2)
        )
        assertFalse("Duplicate symbolId must be rejected", secondArrival)
        assertEquals(1, decoder.recoveredSymbolCount)
    }

    @Test
    fun testRedundantEquationRejection() {
        val (raw, sourceSymbols) = createTestSourceBlock()
        val decoder = BlockDecoder(blockIndex = 0L, k = k, symbolSize = symbolSize)

        // Solve neighbor 0 and 1 directly
        decoder.addSymbol(symbolId = 1L, data = sourceSymbols[0], packetDegree = 1, neighbors = listOf(0))
        decoder.addSymbol(symbolId = 2L, data = sourceSymbols[1], packetDegree = 1, neighbors = listOf(1))
        assertEquals(2, decoder.recoveredSymbolCount)

        // Now add equation [0, 1] -> both already solved, completely redundant
        val eq01 = encodeSymbol(sourceSymbols, listOf(0, 1))
        val useful = decoder.addSymbol(
            symbolId = 3L,
            data = eq01,
            packetDegree = 2,
            neighbors = listOf(0, 1)
        )
        assertFalse("Equation where all neighbors are solved must be rejected as redundant", useful)
    }

    @Test
    fun testInconsistentPacketDegreeRejection() {
        val decoder = BlockDecoder(blockIndex = 0L, k = 16, symbolSize = 64)
        val dummyData = ByteArray(64)

        // For (k=16, block=0, symbolId=0), canonically derived degree is 1
        // If packet claims degree = 5, decoder must reject it without inserting or crashing
        val useful = decoder.addSymbol(
            symbolId = 0L,
            data = dummyData,
            packetDegree = 5 // Inconsistent with canonical degree 1!
        )
        assertFalse("Inconsistent degree must be rejected", useful)
        assertEquals(0, decoder.recoveredSymbolCount)
    }

    @Test
    fun testStalledStatusWhenRippleEmpty() {
        val decoder = BlockDecoder(blockIndex = 0L, k = 4, symbolSize = 16)
        val dummyData = ByteArray(16)

        // Feed single degree-2 equation with neighbors [0, 1]
        val useful = decoder.addSymbol(
            symbolId = 99L,
            data = dummyData,
            packetDegree = 2,
            neighbors = listOf(0, 1)
        )
        assertTrue(useful)
        assertFalse(decoder.isComplete())
        assertEquals(DecoderStatus.STALLED, decoder.getStatus())
        assertNull(decoder.reconstruct())
    }

    @Test
    fun testSuccessfulK16DeterministicReconstruction() {
        val k16 = 16
        val symSize = 64
        val raw = ByteArray(k16 * symSize) { i -> (((i + 1) * 7) and 0xFF).toByte() }
        val sourceSymbols = List(k16) { i ->
            raw.copyOfRange(i * symSize, (i + 1) * symSize)
        }

        val decoder = BlockDecoder(blockIndex = 0L, k = k16, symbolSize = symSize)
        val dist = RobustSolitonDistribution(k16)

        // Generate symbols until complete
        var symbolId = 0L
        while (!decoder.isComplete() && symbolId < 50L) {
            val (degree, neighbors) = LtFountainMath.deriveSymbolNeighbors(k16, 0L, symbolId, dist)
            val symData = ByteArray(symSize)
            for (n in neighbors) {
                val src = sourceSymbols[n]
                for (b in 0 until symSize) {
                    symData[b] = (symData[b].toInt() xor src[b].toInt()).toByte()
                }
            }

            decoder.addSymbol(
                symbolId = symbolId,
                data = symData,
                packetDegree = degree
            )
            symbolId++
        }

        assertTrue("Block must decode completely", decoder.isComplete())
        assertEquals(DecoderStatus.COMPLETE, decoder.getStatus())
        assertEquals(16, decoder.recoveredSymbolCount)

        val reconstructed = decoder.reconstruct()
        assertArrayEquals(raw, reconstructed)
    }

    @Test
    fun testOutOfOrderSymbolsArrival() {
        val k16 = 16
        val symSize = 64
        val raw = ByteArray(k16 * symSize) { i -> (((i + 1) * 7) and 0xFF).toByte() }
        val sourceSymbols = List(k16) { i ->
            raw.copyOfRange(i * symSize, (i + 1) * symSize)
        }

        // Generate 30 symbols
        data class EncodedSym(val symbolId: Long, val degree: Int, val data: ByteArray)
        val generated = mutableListOf<EncodedSym>()
        val dist = RobustSolitonDistribution(k16)

        for (s in 0L until 30L) {
            val (degree, neighbors) = LtFountainMath.deriveSymbolNeighbors(k16, 0L, s, dist)
            val symData = ByteArray(symSize)
            for (n in neighbors) {
                val src = sourceSymbols[n]
                for (b in 0 until symSize) {
                    symData[b] = (symData[b].toInt() xor src[b].toInt()).toByte()
                }
            }
            generated.add(EncodedSym(s, degree, symData))
        }

        // Deterministic shuffle: reverse order
        val shuffled = generated.reversed()

        val decoder = BlockDecoder(blockIndex = 0L, k = k16, symbolSize = symSize)
        for (sym in shuffled) {
            decoder.addSymbol(
                symbolId = sym.symbolId,
                data = sym.data,
                packetDegree = sym.degree
            )
            if (decoder.isComplete()) break
        }

        assertTrue("Out-of-order block must decode completely", decoder.isComplete())
        val reconstructed = decoder.reconstruct()
        assertArrayEquals(raw, reconstructed)
    }
}

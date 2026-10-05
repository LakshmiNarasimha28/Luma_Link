package com.lumalink.harness.fec

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Unit tests verifying exact golden parity of symbol seed derivation
 * and neighbor selection matching Phase 5C.3 Section 12.B and 12.C specifications.
 */
class LtFountainMathTest {

    @Test
    fun testGoldenSymbolSeedsBlockZero() {
        assertEquals(0x00000000L, LtFountainMath.deriveSymbolSeed(0L, 0L))
        assertEquals(0xcb72770fL, LtFountainMath.deriveSymbolSeed(0L, 1L))
        assertEquals(0xfebe41f4L, LtFountainMath.deriveSymbolSeed(0L, 2L))
        assertEquals(0x5197cd6aL, LtFountainMath.deriveSymbolSeed(0L, 3L))
        assertEquals(0x41c6db49L, LtFountainMath.deriveSymbolSeed(0L, 4L))

        assertEquals(0L, LtFountainMath.deriveSymbolSeed(0L, 0L))
        assertEquals(3413276431L, LtFountainMath.deriveSymbolSeed(0L, 1L))
        assertEquals(4273881588L, LtFountainMath.deriveSymbolSeed(0L, 2L))
        assertEquals(1368903018L, LtFountainMath.deriveSymbolSeed(0L, 3L))
        assertEquals(1103551305L, LtFountainMath.deriveSymbolSeed(0L, 4L))
    }

    @Test
    fun testGoldenSymbolNeighborsK16BlockZero() {
        val k = 16
        val dist = RobustSolitonDistribution(k)

        // sym 0: degree 1, neighbors [3]
        val (d0, n0) = LtFountainMath.deriveSymbolNeighbors(k, 0L, 0L, dist)
        assertEquals(1, d0)
        assertEquals(listOf(3), n0)

        // sym 1: degree 13, neighbors [0, 1, 3, 4, 5, 6, 8, 9, 10, 12, 13, 14, 15]
        val (d1, n1) = LtFountainMath.deriveSymbolNeighbors(k, 0L, 1L, dist)
        assertEquals(13, d1)
        assertEquals(listOf(0, 1, 3, 4, 5, 6, 8, 9, 10, 12, 13, 14, 15), n1)

        // sym 2: degree 1, neighbors [3]
        val (d2, n2) = LtFountainMath.deriveSymbolNeighbors(k, 0L, 2L, dist)
        assertEquals(1, d2)
        assertEquals(listOf(3), n2)

        // sym 3: degree 6, neighbors [0, 2, 7, 8, 13, 14]
        val (d3, n3) = LtFountainMath.deriveSymbolNeighbors(k, 0L, 3L, dist)
        assertEquals(6, d3)
        assertEquals(listOf(0, 2, 7, 8, 13, 14), n3)

        // sym 4: degree 2, neighbors [10, 14]
        val (d4, n4) = LtFountainMath.deriveSymbolNeighbors(k, 0L, 4L, dist)
        assertEquals(2, d4)
        assertEquals(listOf(10, 14), n4)
    }

    @Test
    fun testGoldenSymbolNeighborsK8BlockZero() {
        val k = 8
        val dist = RobustSolitonDistribution(k)

        val (d0, n0) = LtFountainMath.deriveSymbolNeighbors(k, 0L, 0L, dist)
        assertEquals(1, d0)
        assertEquals(listOf(1), n0)

        val (d1, n1) = LtFountainMath.deriveSymbolNeighbors(k, 0L, 1L, dist)
        assertEquals(8, d1)
        assertEquals(listOf(0, 1, 2, 3, 4, 5, 6, 7), n1)

        val (d2, n2) = LtFountainMath.deriveSymbolNeighbors(k, 0L, 2L, dist)
        assertEquals(1, d2)
        assertEquals(listOf(1), n2)

        val (d3, n3) = LtFountainMath.deriveSymbolNeighbors(k, 0L, 3L, dist)
        assertEquals(5, d3)
        assertEquals(listOf(0, 1, 2, 4, 7), n3)

        val (d4, n4) = LtFountainMath.deriveSymbolNeighbors(k, 0L, 4L, dist)
        assertEquals(2, d4)
        assertEquals(listOf(5, 7), n4)
    }
}

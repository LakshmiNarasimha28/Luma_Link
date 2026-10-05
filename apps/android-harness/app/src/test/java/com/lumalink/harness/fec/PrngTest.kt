package com.lumalink.harness.fec

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests verifying exact deterministic parity of Kotlin Mulberry32 PRNG
 * with packages/core/test/prng.test.ts and canonical reference vectors.
 */
class PrngTest {

    @Test
    fun testGoldenParityVectorsSeed42() {
        val prng = Prng(42L)

        // Seed 42 uint32 golden vectors
        val u1 = prng.nextUint32()
        val u2 = prng.nextUint32()
        val u3 = prng.nextUint32()

        assertEquals(0x99e1ef7cL, u1)
        assertEquals(0x72c32b8aL, u2)
        assertEquals(0xda3b32c0L, u3)

        assertEquals(2581720956L, u1)
        assertEquals(1925393290L, u2)
        assertEquals(3661312704L, u3)

        // Subsequent float calls on same generator
        val f1 = prng.nextFloat()
        val f2 = prng.nextFloat()

        assertEquals(0.6697340414393693, f1, 1e-12)
        assertEquals(0.17481389874592423, f2, 1e-12)

        // Fresh generator first float
        val freshPrng = Prng(42L)
        val freshF1 = freshPrng.nextFloat()
        assertEquals(2581720956.0 / 4294967296.0, freshF1, 1e-12)
        assertEquals(0.6011037519201636, freshF1, 1e-12)
    }

    @Test
    fun testProducesIdenticalSequencesGivenIdenticalSeeds() {
        val prng1 = Prng(42L)
        val prng2 = Prng(42L)

        for (i in 0 until 100) {
            assertEquals(prng1.nextUint32(), prng2.nextUint32())
            assertEquals(prng1.nextFloat(), prng2.nextFloat(), 1e-15)
        }
    }

    @Test
    fun testProducesDistinctSequencesGivenDifferentSeeds() {
        val prng1 = Prng(100L)
        val prng2 = Prng(200L)

        val seq1 = List(10) { prng1.nextUint32() }
        val seq2 = List(10) { prng2.nextUint32() }

        assertNotEquals(seq1, seq2)
    }

    @Test
    fun testGeneratesFloatsStrictlyWithinZeroToOne() {
        val prng = Prng(999L)
        for (i in 0 until 500) {
            val v = prng.nextFloat()
            assertTrue("Value $v should be >= 0.0", v >= 0.0)
            assertTrue("Value $v should be < 1.0", v < 1.0)
        }
    }

    @Test
    fun testGeneratesIntegersInclusivelyWithinBounds() {
        val prng = Prng(12345L)
        val min = 5
        val max = 15
        val counts = mutableSetOf<Int>()

        for (i in 0 until 1000) {
            val v = prng.nextInt(min, max)
            assertTrue(v >= min)
            assertTrue(v <= max)
            counts.add(v)
        }

        // All integers between 5 and 15 should be represented after 1000 trials
        assertEquals(max - min + 1, counts.size)
    }

    @Test(expected = IllegalArgumentException::class)
    fun testThrowsWhenMinGreaterThanMax() {
        val prng = Prng(1L)
        prng.nextInt(10, 5)
    }

    @Test
    fun testForksIntoDeterministicChild() {
        val parent1 = Prng(777L)
        val parent2 = Prng(777L)

        val child1 = parent1.fork()
        val child2 = parent2.fork()

        for (i in 0 until 50) {
            assertEquals(child1.nextUint32(), child2.nextUint32())
        }
    }
}

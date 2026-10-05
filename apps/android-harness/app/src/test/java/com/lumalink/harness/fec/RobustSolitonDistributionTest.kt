package com.lumalink.harness.fec

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests verifying exact parity of RobustSolitonDistribution
 * with packages/core/test/distribution.test.ts.
 */
class RobustSolitonDistributionTest {

    @Test(expected = IllegalArgumentException::class)
    fun testThrowsIfKLessThanOne() {
        RobustSolitonDistribution(0)
    }

    @Test
    fun testGuaranteesDegreeIsOneWhenKIsOne() {
        val dist = RobustSolitonDistribution(1)
        val prng = Prng(42L)

        for (i in 0 until 20) {
            assertEquals(1, dist.sampleDegree(prng))
            val neighbors = dist.sampleNeighbors(1, prng)
            assertEquals(listOf(0), neighbors)
        }
    }

    @Test
    fun testSamplesDegreesStrictlyWithinOneToK() {
        val k = 64
        val dist = RobustSolitonDistribution(k)
        val prng = Prng(123L)

        for (i in 0 until 500) {
            val d = dist.sampleDegree(prng)
            assertTrue("Degree $d must be >= 1", d >= 1)
            assertTrue("Degree $d must be <= $k", d <= k)
        }
    }

    @Test
    fun testSamplesNeighborsWithinValidBoundsNoDuplicates() {
        val k = 32
        val dist = RobustSolitonDistribution(k)
        val prng = Prng(456L)

        for (i in 0 until 100) {
            val degree = dist.sampleDegree(prng)
            val neighbors = dist.sampleNeighbors(degree, prng)

            assertEquals(degree, neighbors.size)

            // Verify bounds
            for (idx in neighbors) {
                assertTrue("Neighbor $idx must be >= 0", idx >= 0)
                assertTrue("Neighbor $idx must be < $k", idx < k)
            }

            // Verify uniqueness
            val unique = neighbors.toSet()
            assertEquals(degree, unique.size)

            // Verify ascending order
            for (j in 0 until neighbors.size - 1) {
                assertTrue("Neighbors must be sorted ascending", neighbors[j] < neighbors[j + 1])
            }
        }
    }

    @Test
    fun testReturnsAllIndicesWhenDegreeEqualsK() {
        val k = 10
        val dist = RobustSolitonDistribution(k)
        val prng = Prng(789L)

        val neighbors = dist.sampleNeighbors(k, prng)
        assertEquals(k, neighbors.size)
        assertEquals((0 until k).toList(), neighbors)
    }

    @Test
    fun testIsCompletelyDeterministicUnderSameSeed() {
        val k = 50
        val dist1 = RobustSolitonDistribution(k)
        val dist2 = RobustSolitonDistribution(k)

        val prng1 = Prng(999L)
        val prng2 = Prng(999L)

        for (i in 0 until 50) {
            val d1 = dist1.sampleDegree(prng1)
            val d2 = dist2.sampleDegree(prng2)
            assertEquals(d1, d2)

            val n1 = dist1.sampleNeighbors(d1, prng1)
            val n2 = dist2.sampleNeighbors(d2, prng2)
            assertEquals(n1, n2)
        }
    }

    @Test(expected = IllegalArgumentException::class)
    fun testThrowsWhenDegreeZero() {
        val dist = RobustSolitonDistribution(10)
        val prng = Prng(1L)
        dist.sampleNeighbors(0, prng)
    }

    @Test(expected = IllegalArgumentException::class)
    fun testThrowsWhenDegreeGreaterThanK() {
        val dist = RobustSolitonDistribution(10)
        val prng = Prng(1L)
        dist.sampleNeighbors(11, prng)
    }
}

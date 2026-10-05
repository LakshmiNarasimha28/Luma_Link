package com.lumalink.harness.fec

/**
 * Robust Soliton degree distribution for Luby Transform (LT) codes.
 * Exact parity with packages/core/src/fec/distribution.ts.
 *
 * Provides the probability distribution mu(d) over degrees d in [1, K]
 * such that the decoder ripple (number of degree-1 symbols available for peeling)
 * remains neither empty (stalling) nor excessively large (redundant work).
 */
class RobustSolitonDistribution(
    val k: Int,
    val c: Double = DEFAULT_C,
    val delta: Double = DEFAULT_DELTA
) {
    companion object {
        const val DEFAULT_C: Double = 0.1
        const val DEFAULT_DELTA: Double = 0.05
    }

    private val cdf: DoubleArray

    init {
        require(k >= 1) { "Number of source symbols K ($k) must be >= 1" }
        cdf = DoubleArray(k)
        computeCdf()
    }

    private fun computeCdf() {
        if (k == 1) {
            cdf[0] = 1.0
            return
        }

        val kDouble = k.toDouble()
        // R = c * ln(K / delta) * sqrt(K)
        val r = c * Math.log(kDouble / delta) * Math.sqrt(kDouble)
        val pivot = Math.max(1, Math.min(k, Math.floor(kDouble / r).toInt()))

        val pdf = DoubleArray(k)
        var sum = 0.0

        for (d in 1..k) {
            // 1. Ideal Soliton component rho(d)
            val rho = if (d == 1) {
                1.0 / kDouble
            } else {
                1.0 / (d.toDouble() * (d - 1).toDouble())
            }

            // 2. Robust spike component tau(d)
            val tau = when {
                d < pivot -> r / (d.toDouble() * kDouble)
                d == pivot -> (r * Math.log(Math.max(1.0, r / delta))) / kDouble
                else -> 0.0
            }

            val mu = rho + tau
            pdf[d - 1] = mu
            sum += mu
        }

        // Normalize to form valid probability distribution and compute CDF
        var cumulative = 0.0
        for (i in 0 until k) {
            val p = pdf[i] / sum
            cumulative += p
            cdf[i] = cumulative
        }
        // Ensure final element is exactly 1.0
        cdf[k - 1] = 1.0
    }

    /**
     * Samples a degree d in [1, K] deterministically using the supplied PRNG.
     */
    fun sampleDegree(prng: Prng): Int {
        if (k == 1) {
            return 1
        }

        val u = prng.nextFloat()
        var low = 0
        var high = k - 1

        while (low < high) {
            val mid = (low + high) ushr 1
            val cdfVal = cdf[mid]
            if (u <= cdfVal) {
                high = mid
            } else {
                low = mid + 1
            }
        }

        return low + 1
    }

    /**
     * Deterministically selects [degree] distinct source symbol indices in [0, K-1]
     * without replacement, using the supplied PRNG.
     *
     * Partial Fisher-Yates shuffle matching TypeScript distribution.ts.
     * Returns sorted ascending list.
     */
    fun sampleNeighbors(degree: Int, prng: Prng): List<Int> {
        require(degree in 1..k) { "Degree ($degree) must be between 1 and K ($k)" }

        if (degree == k) {
            return List(k) { it }
        }

        if (degree == 1) {
            return listOf(prng.nextInt(0, k - 1))
        }

        // Partial Fisher-Yates shuffle on indices [0, K-1]
        val pool = IntArray(k) { it }
        val neighbors = IntArray(degree)

        for (i in 0 until degree) {
            val pickIndex = prng.nextInt(i, k - 1)
            val chosen = pool[pickIndex]
            pool[pickIndex] = pool[i]
            pool[i] = chosen
            neighbors[i] = chosen
        }

        neighbors.sort()
        return neighbors.toList()
    }
}

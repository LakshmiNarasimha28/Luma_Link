package com.lumalink.harness.fec

/**
 * Luby Transform Fountain mathematical utilities.
 * Exact parity with packages/core/src/fec/lt-encoder.ts.
 */
object LtFountainMath {

    /**
     * Derives a deterministic 32-bit seed for a specific block and symbol index.
     * Uses 32-bit golden-ratio and prime multipliers to avoid seed collisions.
     * Exact parity with packages/core/src/fec/lt-encoder.ts [deriveSymbolSeed].
     */
    fun deriveSymbolSeed(blockIndex: Long, symbolId: Long): Long {
        val b = (blockIndex and 0xFFFFFFFFL).toInt()
        val s = (symbolId and 0xFFFFFFFFL).toInt()
        val c1 = 0x9e3779b9.toInt()
        val c2 = 0x85ebca6b.toInt()
        val c3 = 0xc2b2ae35.toInt()

        var h = (b * c1) xor (s * c2)
        h = (h xor (h ushr 16)) * c2
        h = (h xor (h ushr 13)) * c3
        val res = h xor (h ushr 16)
        return res.toLong() and 0xFFFFFFFFL
    }

    /**
     * Deterministically derives the degree and source symbol neighbor set for an encoded symbol.
     * Exact parity with packages/core/src/fec/lt-encoder.ts [deriveSymbolNeighbors].
     */
    fun deriveSymbolNeighbors(
        k: Int,
        blockIndex: Long,
        symbolId: Long,
        distribution: RobustSolitonDistribution? = null
    ): Pair<Int, List<Int>> {
        val dist = distribution ?: RobustSolitonDistribution(k)
        val seed = deriveSymbolSeed(blockIndex, symbolId)
        val prng = Prng(seed)
        val degree = dist.sampleDegree(prng)
        val neighbors = dist.sampleNeighbors(degree, prng)
        return Pair(degree, neighbors)
    }
}

package com.lumalink.harness.fec

/**
 * Deterministic 32-bit pseudo-random number generator for LumaLink.
 * Uses Mulberry32 algorithm: fast, high-quality statistical distribution,
 * fully deterministic, zero external dependencies.
 *
 * Exact parity with packages/core/src/fec/prng.ts.
 */
class Prng(seed: Long) {
    // 32-bit unsigned state stored in a signed Int with unsigned bitwise semantics
    private var state: Int = (seed and 0xFFFFFFFFL).toInt()

    init {
        if (state == 0) {
            state = 0x6d2b79f5
        }
    }

    /**
     * Generates a pseudo-random unsigned 32-bit integer in [0, 2^32 - 1].
     * Returned as an unsigned Long representation in [0L, 4294967295L].
     */
    fun nextUint32(): Long {
        state = state + 0x6d2b79f5
        var t = (state xor (state ushr 15)) * (1 or state)
        t = (t + ((t xor (t ushr 7)) * (61 or t))) xor t
        val res = t xor (t ushr 14)
        return res.toLong() and 0xFFFFFFFFL
    }

    /**
     * Generates a floating point number in [0.0, 1.0).
     * Exact parity with TypeScript: nextUint32() / 4294967296.0.
     */
    fun nextFloat(): Double {
        return nextUint32().toDouble() / 4294967296.0
    }

    /**
     * Generates an integer in [min, max] inclusive.
     */
    fun nextInt(min: Int, max: Int): Int {
        require(min <= max) { "min ($min) cannot be greater than max ($max)" }
        val range = (max.toLong() - min.toLong() + 1L).toDouble()
        return min + Math.floor(nextFloat() * range).toInt()
    }

    /**
     * Returns a child PRNG branched deterministically from the current state.
     */
    fun fork(): Prng {
        return Prng(nextUint32())
    }
}

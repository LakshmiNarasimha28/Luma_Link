package com.lumalink.harness.fec

/**
 * Status of an LT block decoder.
 */
enum class DecoderStatus {
    INCOMPLETE,
    COMPLETE,
    STALLED
}

/**
 * Linear equation holding combined symbol data and unresolved source symbol indices.
 * Uses reference identity for Set and Map storage.
 */
class Equation(
    val data: ByteArray,
    val unresolvedNeighbors: MutableSet<Int>
)

/**
 * Single-block peeling decoder for Luby Transform fountain codes.
 * Exact parity with packages/core/src/fec/lt-decoder.ts [BlockDecoder].
 */
class BlockDecoder(
    val blockIndex: Long,
    val k: Int,
    val symbolSize: Int
) {
    init {
        require(k >= 1) { "K must be >= 1, received $k" }
        require(symbolSize >= 1) { "symbolSize must be >= 1, received $symbolSize" }
    }

    private val sourceSymbols = Array<ByteArray?>(k) { null }
    var recoveredSymbolCount: Int = 0
        private set

    // Active linear equations with degree > 1
    private val equations = mutableSetOf<Equation>()
    // Reverse index mapping each unresolved source index to equations containing it
    private val sourceToEquations = mutableMapOf<Int, MutableSet<Equation>>()
    // Ripple queue containing degree-1 equations ready to be peeled (LIFO / stack behavior via removeLast)
    private val rippleQueue = ArrayDeque<Equation>()
    // Set of received symbol IDs to immediately reject duplicate arrivals
    private val receivedSymbolIds = mutableSetOf<Long>()

    fun isComplete(): Boolean = recoveredSymbolCount == k

    fun getStatus(): DecoderStatus {
        if (isComplete()) {
            return DecoderStatus.COMPLETE
        }
        if (rippleQueue.isEmpty()) {
            return DecoderStatus.STALLED
        }
        return DecoderStatus.INCOMPLETE
    }

    /**
     * Adds an encoded symbol to the decoding graph and triggers peeling reduction.
     * Returns true if the symbol provided novel information (useful equation), false if redundant or rejected.
     *
     * In accordance with Section 6 of Phase 5C.3 specifications:
     * - The LT graph is derived canonically from (k, blockIndex, symbolId).
     * - If [packetDegree] is provided, it is validated against the canonically derived degree.
     * - If they disagree, the symbol is rejected as malformed/inconsistent without crashing.
     */
    fun addSymbol(
        symbolId: Long,
        data: ByteArray,
        packetDegree: Int? = null,
        neighbors: List<Int>? = null
    ): Boolean {
        if (isComplete()) {
            return false // Block already fully decoded
        }

        if (receivedSymbolIds.contains(symbolId)) {
            return false // Exact duplicate symbolId already processed
        }

        // Determine neighbors: use explicit neighbors if provided, otherwise derive canonically
        val chosenNeighbors: List<Int>
        if (neighbors != null && neighbors.isNotEmpty()) {
            if (packetDegree != null && packetDegree != neighbors.size) {
                return false // Inconsistent degree metadata
            }
            chosenNeighbors = neighbors
        } else {
            val (derivedDegree, derivedNeighbors) = LtFountainMath.deriveSymbolNeighbors(k, blockIndex, symbolId)
            if (packetDegree != null && packetDegree != derivedDegree) {
                // Section 6: Reject inconsistent degree without inserting or crashing
                return false
            }
            chosenNeighbors = derivedNeighbors
        }

        if (data.size != symbolSize) {
            throw IllegalArgumentException("Symbol size mismatch: expected $symbolSize, received ${data.size}")
        }

        // Record symbolId arrival after validation
        receivedSymbolIds.add(symbolId)

        // Create mutable equation payload copy
        val equationData = data.copyOf()
        val unresolvedNeighbors = mutableSetOf<Int>()

        // Step 1: XOR out all source symbols that are ALREADY recovered
        for (neighbor in chosenNeighbors) {
            require(neighbor in 0 until k) { "Invalid neighbor index $neighbor for block with K=$k" }
            val existing = sourceSymbols[neighbor]
            if (existing != null) {
                for (b in 0 until symbolSize) {
                    equationData[b] = (equationData[b].toInt() xor existing[b].toInt()).toByte()
                }
            } else {
                unresolvedNeighbors.add(neighbor)
            }
        }

        // Step 2: Evaluate reduced degree
        if (unresolvedNeighbors.isEmpty()) {
            // Equation is completely redundant (all neighbors already solved)
            return false
        }

        val equation = Equation(
            data = equationData,
            unresolvedNeighbors = unresolvedNeighbors
        )

        if (unresolvedNeighbors.size == 1) {
            rippleQueue.addLast(equation)
        } else {
            equations.add(equation)
            for (idx in unresolvedNeighbors) {
                sourceToEquations.getOrPut(idx) { mutableSetOf() }.add(equation)
            }
        }

        // Step 3: Run peeling ripple propagation
        peel()
        return true
    }

    /**
     * Iteratively peels degree-1 equations from the ripple queue until empty or complete.
     * Canonical TypeScript rippleQueue uses `.pop()`, which is LIFO behavior.
     * Kotlin MUST use [ArrayDeque.removeLast] to preserve identical peeling traversal order.
     */
    private fun peel() {
        while (rippleQueue.isNotEmpty() && !isComplete()) {
            val eq = rippleQueue.removeLast()
            if (eq.unresolvedNeighbors.size != 1) {
                continue
            }

            val sourceIdx = eq.unresolvedNeighbors.first()

            // If already recovered in a concurrent peeling step, skip
            if (sourceSymbols[sourceIdx] != null) {
                continue
            }

            // Recover source symbol
            sourceSymbols[sourceIdx] = eq.data
            recoveredSymbolCount++

            // Propagate recovered symbol to all equations containing it
            val dependents = sourceToEquations.remove(sourceIdx)
            if (dependents != null) {
                for (dep in dependents) {
                    if (!equations.contains(dep)) {
                        continue
                    }

                    // XOR out newly recovered source symbol
                    for (b in 0 until symbolSize) {
                        dep.data[b] = (dep.data[b].toInt() xor eq.data[b].toInt()).toByte()
                    }
                    dep.unresolvedNeighbors.remove(sourceIdx)

                    if (dep.unresolvedNeighbors.size == 1) {
                        equations.remove(dep)
                        rippleQueue.addLast(dep)
                    } else if (dep.unresolvedNeighbors.isEmpty()) {
                        // Degenerate/redundant equation
                        equations.remove(dep)
                    }
                }
            }
        }
    }

    /**
     * Returns the concatenated reconstructed source block if complete, or null if incomplete.
     */
    fun reconstruct(): ByteArray? {
        if (!isComplete()) {
            return null
        }

        val totalBytes = k * symbolSize
        val result = ByteArray(totalBytes)
        for (i in 0 until k) {
            val sym = sourceSymbols[i] ?: return null
            System.arraycopy(sym, 0, result, i * symbolSize, symbolSize)
        }
        return result
    }
}

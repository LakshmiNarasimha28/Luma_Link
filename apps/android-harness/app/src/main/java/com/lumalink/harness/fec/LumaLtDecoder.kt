package com.lumalink.harness.fec

/**
 * Multi-block Luby Transform Fountain Decoder manager.
 * Exact parity with packages/core/src/fec/lt-decoder.ts [LtDecoder].
 *
 * Maintains independent [BlockDecoder] instances keyed by blockIndex.
 * Supports:
 * - out-of-order blocks
 * - out-of-order symbols
 * - duplicate symbols
 * - multiple active blocks in parallel
 */
class LumaLtDecoder(
    val defaultSymbolSize: Int = 64
) {
    private val blockDecoders = mutableMapOf<Long, BlockDecoder>()

    /**
     * Registers or retrieves a block decoder with known K and symbolSize.
     */
    fun registerBlock(blockIndex: Long, k: Int, symbolSize: Int = defaultSymbolSize): BlockDecoder {
        return blockDecoders.getOrPut(blockIndex) {
            BlockDecoder(blockIndex = blockIndex, k = k, symbolSize = symbolSize)
        }
    }

    /**
     * Ingests an authenticated symbol into the corresponding block decoder.
     * Automatically initializes block decoder if not yet registered.
     */
    fun addSymbol(
        blockIndex: Long,
        symbolId: Long,
        k: Int,
        data: ByteArray,
        degree: Int? = null,
        symbolSize: Int = defaultSymbolSize
    ): Boolean {
        val decoder = blockDecoders.getOrPut(blockIndex) {
            BlockDecoder(blockIndex = blockIndex, k = k, symbolSize = symbolSize)
        }
        return decoder.addSymbol(
            symbolId = symbolId,
            data = data,
            packetDegree = degree
        )
    }

    /**
     * Checks if the specified block is completely decoded (recoveredCount == K).
     */
    fun isBlockComplete(blockIndex: Long): Boolean {
        return blockDecoders[blockIndex]?.isComplete() ?: false
    }

    /**
     * Returns the decoder status of the specified block.
     */
    fun getBlockStatus(blockIndex: Long): DecoderStatus {
        return blockDecoders[blockIndex]?.getStatus() ?: DecoderStatus.INCOMPLETE
    }

    /**
     * Returns the concatenated reconstructed source block if complete, or null if incomplete.
     */
    fun reconstructBlock(blockIndex: Long): ByteArray? {
        return blockDecoders[blockIndex]?.reconstruct()
    }

    /**
     * Returns the underlying block decoder instance for the specified block.
     */
    fun getBlockDecoder(blockIndex: Long): BlockDecoder? {
        return blockDecoders[blockIndex]
    }

    /**
     * Clears all active block decoders and resets state.
     */
    fun reset() {
        blockDecoders.clear()
    }
}

package com.lumalink.harness.transfer

/**
 * Result of a successful file reassembly and SHA-256 verification.
 * Exact parity with packages/core/src/transfer/reassembler.ts [ReassemblyResult].
 */
data class ReassemblyResult(
    val success: Boolean,
    val fileBytes: ByteArray,
    val verifiedSha256: Boolean,
    val sha256Digest: String
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false

        other as ReassemblyResult

        if (success != other.success) return false
        if (!fileBytes.contentEquals(other.fileBytes)) return false
        if (verifiedSha256 != other.verifiedSha256) return false
        if (!sha256Digest.equals(other.sha256Digest, ignoreCase = true)) return false

        return true
    }

    override fun hashCode(): Int {
        var result = success.hashCode()
        result = 31 * result + fileBytes.contentHashCode()
        result = 31 * result + verifiedSha256.hashCode()
        result = 31 * result + sha256Digest.lowercase().hashCode()
        return result
    }
}

/**
 * Reassembles decoded source blocks into the verified original user file.
 * Automatically slices off block-level padding and strictly verifies SHA-256 integrity.
 * Exact parity with packages/core/src/transfer/reassembler.ts [FileReassembler].
 */
class LumaFileReassembler(
    val manifest: LumaFileManifest,
    val hasher: LumaHasher = PlatformHasher()
) {
    private val blocks = mutableMapOf<Long, ByteArray>()

    /**
     * Adds a successfully decoded source block.
     * Duplicate block additions are idempotent.
     */
    fun addBlock(blockIndex: Long, blockData: ByteArray) {
        if (blockIndex < 0 || blockIndex >= manifest.totalBlocks) {
            throw IllegalArgumentException(
                "Invalid block index $blockIndex: expected [0, ${manifest.totalBlocks - 1}]"
            )
        }
        blocks[blockIndex] = blockData
    }

    /**
     * Returns whether all blocks required to assemble the file are available.
     */
    fun isComplete(): Boolean {
        return blocks.size == manifest.totalBlocks
    }

    /**
     * Returns list of block indices that are still missing.
     */
    fun getMissingBlocks(): List<Long> {
        val missing = mutableListOf<Long>()
        for (b in 0L until manifest.totalBlocks.toLong()) {
            if (!blocks.containsKey(b)) {
                missing.add(b)
            }
        }
        return missing
    }

    /**
     * Number of blocks currently received.
     */
    fun getReceivedBlockCount(): Int = blocks.size

    /**
     * Assembles all blocks, trims padding, and verifies SHA-256 integrity.
     * Throws [IncompleteTransferException] if any block is missing.
     * Throws [Sha256MismatchException] if reconstructed hash does not match manifest.
     */
    fun reassemble(): ReassemblyResult {
        val missing = getMissingBlocks()
        if (missing.isNotEmpty()) {
            throw IncompleteTransferException(missing)
        }

        if (manifest.fileSize == 0L) {
            val empty = ByteArray(0)
            val hash = hasher.hashSha256(empty)
            if (!hash.equals(manifest.sha256Digest, ignoreCase = true)) {
                throw Sha256MismatchException(manifest.sha256Digest, hash)
            }
            return ReassemblyResult(
                success = true,
                fileBytes = empty,
                verifiedSha256 = true,
                sha256Digest = hash
            )
        }

        if (manifest.fileSize > Int.MAX_VALUE) {
            throw UnsupportedOperationException("File size exceeds Int.MAX_VALUE bytes: ${manifest.fileSize}")
        }

        // Allocate buffer for the exact unpadded file size
        val assembled = ByteArray(manifest.fileSize.toInt())
        var offset = 0

        for (b in 0L until manifest.totalBlocks.toLong()) {
            val blockBytes = blocks[b]
                ?: throw IncompleteTransferException(listOf(b))
            val remaining = assembled.size - offset
            val toCopy = Math.min(blockBytes.size, remaining)

            System.arraycopy(blockBytes, 0, assembled, offset, toCopy)
            offset += toCopy
        }

        // Verify SHA-256
        val actualDigest = hasher.hashSha256(assembled)
        if (!actualDigest.equals(manifest.sha256Digest, ignoreCase = true)) {
            throw Sha256MismatchException(manifest.sha256Digest, actualDigest)
        }

        return ReassemblyResult(
            success = true,
            fileBytes = assembled,
            verifiedSha256 = true,
            sha256Digest = actualDigest
        )
    }

    /**
     * Resets the reassembler internal state.
     */
    fun reset() {
        blocks.clear()
    }
}

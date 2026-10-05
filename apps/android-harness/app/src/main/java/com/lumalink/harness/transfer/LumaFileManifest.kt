package com.lumalink.harness.transfer

/**
 * File manifest metadata describing the transfer payload.
 * Exact parity with packages/core/src/transfer/blocker.ts [FileManifest].
 */
data class LumaFileManifest(
    val sessionId: ByteArray,
    val fileName: String,
    val fileSize: Long,
    val sha256Digest: String,
    val symbolSize: Int,
    val symbolsPerBlock: Int,
    val totalBlocks: Int,
    val mimeType: String = "application/octet-stream"
) {
    init {
        require(sessionId.size == 16) { "Session ID must be 16 bytes, received ${sessionId.size}" }
        require(fileSize >= 0) { "fileSize must be >= 0, received $fileSize" }
        require(symbolSize >= 1) { "symbolSize must be >= 1, received $symbolSize" }
        require(symbolsPerBlock >= 1) { "symbolsPerBlock must be >= 1, received $symbolsPerBlock" }
        require(totalBlocks >= 1) { "totalBlocks must be >= 1, received $totalBlocks" }
        require(sha256Digest.length == 64) { "sha256Digest must be 64 hex characters, received ${sha256Digest.length}" }
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false

        other as LumaFileManifest

        if (!sessionId.contentEquals(other.sessionId)) return false
        if (fileName != other.fileName) return false
        if (fileSize != other.fileSize) return false
        if (!sha256Digest.equals(other.sha256Digest, ignoreCase = true)) return false
        if (symbolSize != other.symbolSize) return false
        if (symbolsPerBlock != other.symbolsPerBlock) return false
        if (totalBlocks != other.totalBlocks) return false
        if (mimeType != other.mimeType) return false

        return true
    }

    override fun hashCode(): Int {
        var result = sessionId.contentHashCode()
        result = 31 * result + fileName.hashCode()
        result = 31 * result + fileSize.hashCode()
        result = 31 * result + sha256Digest.lowercase().hashCode()
        result = 31 * result + symbolSize
        result = 31 * result + symbolsPerBlock
        result = 31 * result + totalBlocks
        result = 31 * result + mimeType.hashCode()
        return result
    }
}

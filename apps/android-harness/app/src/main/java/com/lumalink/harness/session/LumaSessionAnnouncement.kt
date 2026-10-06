package com.lumalink.harness.session

import com.lumalink.harness.transfer.LumaFileManifest

/**
 * Session announcement metadata received in a MANIFEST packet over the visual channel.
 *
 * Direct parity with TypeScript [SessionAnnouncement] (packages/core/src/session/types.ts).
 */
data class LumaSessionAnnouncement(
    val sessionId: ByteArray,
    val mode: String, // "quick" or "private"
    val senderDeviceId: String,
    val senderPublicKey: ByteArray,
    val fileName: String,
    val fileSize: Long,
    val sha256Digest: String,
    val symbolSize: Int,
    val symbolsPerBlock: Int,
    val totalBlocks: Int,
    val timestamp: Long
) {
    init {
        require(sessionId.size == 16) { "Session ID must be 16 bytes, received ${sessionId.size}" }
        require(mode == "quick" || mode == "private") { "mode must be 'quick' or 'private', received '$mode'" }
        require(senderPublicKey.size == 32) { "senderPublicKey must be 32 bytes, received ${senderPublicKey.size}" }
        require(fileSize >= 0) { "fileSize must be >= 0, received $fileSize" }
        require(symbolSize >= 1) { "symbolSize must be >= 1, received $symbolSize" }
        require(symbolsPerBlock >= 1) { "symbolsPerBlock must be >= 1, received $symbolsPerBlock" }
        require(totalBlocks >= 1) { "totalBlocks must be >= 1, received $totalBlocks" }
        require(sha256Digest.length == 64) { "sha256Digest must be 64 hex characters, received ${sha256Digest.length}" }
        require(timestamp >= 0) { "timestamp must be >= 0, received $timestamp" }
    }

    val sessionIdHex: String
        get() {
            val sb = java.lang.StringBuilder(sessionId.size * 2)
            for (b in sessionId) {
                val v = b.toInt() and 0xFF
                if (v < 16) sb.append('0')
                sb.append(Integer.toHexString(v))
            }
            return sb.toString()
        }

    /**
     * Converts the announcement metadata into a [LumaFileManifest] for file reassembly.
     */
    fun toFileManifest(mimeType: String = "application/octet-stream"): LumaFileManifest {
        return LumaFileManifest(
            sessionId = sessionId.copyOf(),
            fileName = fileName,
            fileSize = fileSize,
            sha256Digest = sha256Digest.lowercase(),
            symbolSize = symbolSize,
            symbolsPerBlock = symbolsPerBlock,
            totalBlocks = totalBlocks,
            mimeType = mimeType
        )
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false

        other as LumaSessionAnnouncement

        if (!sessionId.contentEquals(other.sessionId)) return false
        if (mode != other.mode) return false
        if (senderDeviceId != other.senderDeviceId) return false
        if (!senderPublicKey.contentEquals(other.senderPublicKey)) return false
        if (fileName != other.fileName) return false
        if (fileSize != other.fileSize) return false
        if (!sha256Digest.equals(other.sha256Digest, ignoreCase = true)) return false
        if (symbolSize != other.symbolSize) return false
        if (symbolsPerBlock != other.symbolsPerBlock) return false
        if (totalBlocks != other.totalBlocks) return false
        if (timestamp != other.timestamp) return false

        return true
    }

    override fun hashCode(): Int {
        var result = sessionId.contentHashCode()
        result = 31 * result + mode.hashCode()
        result = 31 * result + senderDeviceId.hashCode()
        result = 31 * result + senderPublicKey.contentHashCode()
        result = 31 * result + fileName.hashCode()
        result = 31 * result + fileSize.hashCode()
        result = 31 * result + sha256Digest.lowercase().hashCode()
        result = 31 * result + symbolSize
        result = 31 * result + symbolsPerBlock
        result = 31 * result + totalBlocks
        result = 31 * result + timestamp.hashCode()
        return result
    }
}

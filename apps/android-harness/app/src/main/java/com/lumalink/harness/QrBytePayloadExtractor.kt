package com.lumalink.harness

import com.google.zxing.Result
import com.google.zxing.ResultMetadataType

/**
 * Isolated helper to safely extract exact binary wire payloads from ZXing [Result].
 *
 * Requirements:
 * - Obtains the binary Byte Mode payload from [ResultMetadataType.BYTE_SEGMENTS].
 * - Concatenates multiple segments in order if returned by ZXing.
 * - Returns null if BYTE_SEGMENTS is missing or empty.
 * - NEVER falls back to result.text (corrupts arbitrary bytes >= 0x80 under UTF-8).
 * - NEVER uses result.rawBytes (returns QR codeword stream with RS parity, not protocol bytes).
 */
object QrBytePayloadExtractor {

    fun extract(result: Result?): ByteArray? {
        if (result == null) return null
        val metadata = result.resultMetadata ?: return null
        val rawSegments = metadata[ResultMetadataType.BYTE_SEGMENTS] ?: return null

        @Suppress("UNCHECKED_CAST")
        val segments: List<ByteArray> = when (rawSegments) {
            is List<*> -> rawSegments.filterIsInstance<ByteArray>()
            is Array<*> -> rawSegments.filterIsInstance<ByteArray>()
            is Iterable<*> -> rawSegments.filterIsInstance<ByteArray>()
            is ByteArray -> listOf(rawSegments)
            else -> return null
        }

        if (segments.isEmpty()) return null

        if (segments.size == 1) {
            val single = segments[0]
            return if (single.isNotEmpty()) single.copyOf() else null
        }

        var totalLength = 0
        for (seg in segments) {
            totalLength += seg.size
        }
        if (totalLength == 0) return null

        val combined = ByteArray(totalLength)
        var offset = 0
        for (seg in segments) {
            System.arraycopy(seg, 0, combined, offset, seg.size)
            offset += seg.size
        }
        return combined
    }
}

package com.lumalink.harness

import java.util.ArrayDeque
import kotlin.math.abs

/**
 * Sliding window interval and FPS tracker.
 * Used independently for camera frame arrival tracking and decoder throughput tracking.
 */
class IntervalTracker(private val maxWindowSize: Int = 60) {
    private var lastTimestampMs: Long = 0
    private val intervals = ArrayDeque<Double>(maxWindowSize)

    fun recordTimestamp(timestampMs: Long): Double {
        if (lastTimestampMs > 0 && timestampMs >= lastTimestampMs) {
            val interval = (timestampMs - lastTimestampMs).toDouble()
            intervals.addLast(interval)
            if (intervals.size > maxWindowSize) {
                intervals.removeFirst()
            }
        }
        lastTimestampMs = timestampMs
        return computeFps()
    }

    fun computeMeanInterval(): Double {
        return if (intervals.isNotEmpty()) intervals.average() else 0.0
    }

    fun computeFps(): Double {
        val mean = computeMeanInterval()
        return if (mean > 0) 1000.0 / mean else 0.0
    }

    fun computeJitter(): Double {
        val mean = computeMeanInterval()
        return if (intervals.isNotEmpty()) {
            intervals.map { abs(it - mean) }.average()
        } else 0.0
    }

    fun getSampleCount(): Int = intervals.size

    fun reset() {
        lastTimestampMs = 0
        intervals.clear()
    }
}

/**
 * Three-tier duplicate classifier conforming to Section 7 specification.
 */
class DuplicateClassifier(private val cameraDuplicateThresholdMs: Long = 40L) {
    private var lastPayloadHash: Int = 0
    private var lastPayloadTimestampMs: Long = 0
    private val seenPacketIdentifiers = HashSet<String>()

    var cameraDuplicates: Long = 0
        private set
    var frameRepetitions: Long = 0
        private set
    var packetDuplicates: Long = 0
        private set
    var novelPackets: Long = 0
        private set
    var uniquePayloadBytesDelivered: Long = 0
        private set

    fun classify(
        rawPayload: ByteArray,
        packetId: String,
        timestampMs: Long
    ): String {
        val hash = rawPayload.contentHashCode()
        val payloadBytes = rawPayload.size
        val classification: String

        if (hash == lastPayloadHash && lastPayloadTimestampMs > 0) {
            val delta = timestampMs - lastPayloadTimestampMs
            lastPayloadTimestampMs = timestampMs
            if (delta <= cameraDuplicateThresholdMs) {
                classification = "CAMERA_DUPLICATE"
                cameraDuplicates++
            } else {
                classification = "FRAME_REPETITION"
                frameRepetitions++
            }
        } else {
            lastPayloadHash = hash
            lastPayloadTimestampMs = timestampMs

            if (seenPacketIdentifiers.contains(packetId)) {
                classification = "PACKET_DUPLICATE"
                packetDuplicates++
            } else {
                classification = "NOVEL"
                novelPackets++
                uniquePayloadBytesDelivered += payloadBytes
                seenPacketIdentifiers.add(packetId)
            }
        }

        return classification
    }

    fun reset() {
        lastPayloadHash = 0
        lastPayloadTimestampMs = 0
        seenPacketIdentifiers.clear()
        cameraDuplicates = 0
        frameRepetitions = 0
        packetDuplicates = 0
        novelPackets = 0
        uniquePayloadBytesDelivered = 0
    }
}

/**
 * Goodput snapshot representing the three distinct performance layers (§11):
 * - Level 1: Software Codec CPU Throughput (decoded bytes / CPU decode seconds)
 * - Level 2: Physical Optical Channel Goodput (novel payload bytes / wall-clock elapsed seconds)
 * - Level 3: End-to-End Verified File Goodput (verified plaintext file bytes / total transfer duration)
 */
data class GoodputSnapshot(
    val l1CodecBps: Double,
    val l2OpticalBps: Double,
    val l3E2EBps: Double?,
    val isVerifiedTransferActive: Boolean = false
) {
    fun formatHudString(): String {
        val l3Str = if (isVerifiedTransferActive && l3E2EBps != null && l3E2EBps > 0) {
            String.format("%.0f B/s", l3E2EBps)
        } else {
            "N/A (Mock/No SHA-256)"
        }
        return String.format(
            "Goodput: L1 Codec: %.0f B/s | L2 Optical: %.0f B/s | L3 E2E: %s",
            l1CodecBps,
            l2OpticalBps,
            l3Str
        )
    }
}

/**
 * Calculates the three distinct performance layers conforming strictly to Phase 4 Specification §11.
 * Prevents Level 2 Optical link goodput from falsely being reported as Level 3 Verified File goodput.
 */
object GoodputCalculator {

    fun computeGoodput(
        totalDecodedBytes: Long,
        totalDecodeLatencyMs: Double,
        uniquePayloadBytesDelivered: Long,
        elapsedDurationSec: Double,
        verifiedFileBytes: Long = 0L,
        verifiedTransferDurationSec: Double = 0.0
    ): GoodputSnapshot {
        val decodeCpuSec = totalDecodeLatencyMs / 1000.0
        val l1Codec = if (decodeCpuSec > 0) totalDecodedBytes / decodeCpuSec else 0.0
        val l2Optical = if (elapsedDurationSec > 0) uniquePayloadBytesDelivered / elapsedDurationSec else 0.0

        val isVerified = verifiedFileBytes > 0L && verifiedTransferDurationSec > 0.0
        val l3E2E = if (isVerified) verifiedFileBytes / verifiedTransferDurationSec else null

        return GoodputSnapshot(
            l1CodecBps = l1Codec,
            l2OpticalBps = l2Optical,
            l3E2EBps = l3E2E,
            isVerifiedTransferActive = isVerified
        )
    }
}

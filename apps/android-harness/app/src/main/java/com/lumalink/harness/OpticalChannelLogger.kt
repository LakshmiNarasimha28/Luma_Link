package com.lumalink.harness

import android.os.Build
import org.json.JSONObject
import java.io.File
import java.io.FileWriter

/**
 * Structured optical channel benchmark logger conforming to Section 22 specification.
 * Exports reproducible JSON benchmark records of physical screen-to-camera experiments.
 */
data class BenchmarkMetadata(
    val senderModel: String,
    val receiverModel: String = "${Build.MANUFACTURER} ${Build.MODEL}",
    val androidVersion: String = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
    val cameraUsed: String = "Back Camera (CameraX)",
    val displayResolution: String,
    val displayRefreshRateHz: Int,
    val screenBrightness: Float,
    val qrVersion: Int,
    val qrEcc: String,
    val payloadSizeBytes: Int,
    val renderedPixelDimensions: String,
    val pixelsPerModule: Float,
    val distanceCm: Float,
    val angleDegrees: Float,
    val lightingCondition: String,
    val targetFrameIntervalMs: Long,
    val observedFps: Float,
    val displayedFrames: Int,
    val capturedFrames: Long,
    val decodedFrames: Long,
    val uniquePackets: Long,
    val cameraDuplicates: Long,
    val frameRepetitions: Long,
    val failedDecodes: Long,
    val elapsedDurationMs: Long,
    val opticalGoodputBps: Float,
    val endToEndGoodputBps: Float?
)

object OpticalChannelLogger {

    fun exportRecordJson(metadata: BenchmarkMetadata): String {
        val root = JSONObject()

        val device = JSONObject().apply {
            put("senderModel", metadata.senderModel)
            put("receiverModel", metadata.receiverModel)
            put("androidVersion", metadata.androidVersion)
            put("cameraUsed", metadata.cameraUsed)
        }
        root.put("device", device)

        val display = JSONObject().apply {
            put("resolution", metadata.displayResolution)
            put("refreshRateHz", metadata.displayRefreshRateHz)
            put("brightness", metadata.screenBrightness)
        }
        root.put("display", display)

        val qr = JSONObject().apply {
            put("version", metadata.qrVersion)
            put("ecc", metadata.qrEcc)
            put("payloadSizeBytes", metadata.payloadSizeBytes)
            put("renderedPixelDimensions", metadata.renderedPixelDimensions)
            put("pixelsPerModule", metadata.pixelsPerModule)
        }
        root.put("qr", qr)

        val env = JSONObject().apply {
            put("distanceCm", metadata.distanceCm)
            put("angleDegrees", metadata.angleDegrees)
            put("lightingCondition", metadata.lightingCondition)
        }
        root.put("environment", env)

        val timing = JSONObject().apply {
            put("targetFrameIntervalMs", metadata.targetFrameIntervalMs)
            put("observedFps", metadata.observedFps)
        }
        root.put("timing", timing)

        val results = JSONObject().apply {
            put("displayedFrames", metadata.displayedFrames)
            put("capturedFrames", metadata.capturedFrames)
            put("decodedFrames", metadata.decodedFrames)
            put("uniquePackets", metadata.uniquePackets)
            put("cameraDuplicates", metadata.cameraDuplicates)
            put("frameRepetitions", metadata.frameRepetitions)
            put("failedDecodes", metadata.failedDecodes)
            put("elapsedDurationMs", metadata.elapsedDurationMs)
            put("opticalGoodputBps", metadata.opticalGoodputBps)
            metadata.endToEndGoodputBps?.let { put("endToEndGoodputBps", it) }
        }
        root.put("results", results)

        return root.toString(2)
    }

    fun saveRecordToFile(file: File, metadata: BenchmarkMetadata) {
        val json = exportRecordJson(metadata)
        FileWriter(file).use { writer ->
            writer.write(json)
        }
    }
}

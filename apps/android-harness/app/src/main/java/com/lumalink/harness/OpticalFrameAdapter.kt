package com.lumalink.harness

import androidx.camera.core.ImageProxy
import java.nio.ByteBuffer

/**
 * Optical Frame representation within the Android platform layer.
 * Mirrors the platform-independent @lumalink/core OpticalChannel abstraction
 * without leaking Android SDK types into the core protocol library.
 */
data class AndroidCapturedFrameMetadata(
    val sensorTimestampNs: Long,
    val exposureTimeNs: Long?,
    val iso: Int?,
    val focusDistance: Float?,
    val rotationDegrees: Int,
    val lensFacing: String
)

data class AndroidCapturedFrame(
    val sequenceNumber: Long,
    val timestampMs: Long,
    val width: Int,
    val height: Int,
    val pixelFormat: String, // "grayscale" (Y plane) or "rgba8888"
    val data: ByteArray,
    val metadata: AndroidCapturedFrameMetadata
)

object OpticalFrameAdapter {
    /**
     * Extracts the luminance (Y) plane from a CameraX YUV_420_888 ImageProxy.
     * For high-speed visual QR decoding, luminance alone provides complete contrast
     * without the CPU overhead of full RGB color conversion.
     */
    fun extractLuminancePlane(
        image: ImageProxy,
        sequenceNumber: Long,
        timestampMs: Long
    ): AndroidCapturedFrame {
        val yPlane = image.planes[0]
        val yBuffer: ByteBuffer = yPlane.buffer
        val width = image.width
        val height = image.height
        val rowStride = yPlane.rowStride
        val pixelStride = yPlane.pixelStride

        val yBytes = ByteArray(width * height)

        if (rowStride == width && pixelStride == 1) {
            // Direct contiguous memory copy
            yBuffer.rewind()
            yBuffer.get(yBytes, 0, yBytes.size)
        } else {
            // Non-contiguous rows: copy row-by-row
            yBuffer.rewind()
            for (row in 0 until height) {
                yBuffer.position(row * rowStride)
                yBuffer.get(yBytes, row * width, width)
            }
        }

        val metadata = AndroidCapturedFrameMetadata(
            sensorTimestampNs = image.imageInfo.timestamp,
            exposureTimeNs = null, // Populated via Camera2Interop if HAL permits
            iso = null,
            focusDistance = null,
            rotationDegrees = image.imageInfo.rotationDegrees,
            lensFacing = "back"
        )

        return AndroidCapturedFrame(
            sequenceNumber = sequenceNumber,
            timestampMs = timestampMs,
            width = width,
            height = height,
            pixelFormat = "grayscale",
            data = yBytes,
            metadata = metadata
        )
    }
}

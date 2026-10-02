package com.lumalink.harness

/**
 * Region of Interest (ROI) bounding box within a captured optical frame.
 */
data class RoiBounds(
    val left: Int,
    val top: Int,
    val width: Int,
    val height: Int
)

/**
 * Computes centered Region of Interest (ROI) crops for optical frame decoding.
 * Aligns the decode area with the visual reticle on screen, dramatically reducing
 * CPU binarization and pattern scanning overhead on budget mobile processors.
 */
object CenterRoiHelper {

    const val DEFAULT_ROI_SIZE = 480

    /**
     * Calculates a centered bounding box within [frameWidth] x [frameHeight].
     * Clamps the ROI dimensions so they never exceed frame dimensions.
     */
    fun computeCenterRoi(
        frameWidth: Int,
        frameHeight: Int,
        targetWidth: Int = DEFAULT_ROI_SIZE,
        targetHeight: Int = DEFAULT_ROI_SIZE
    ): RoiBounds {
        require(frameWidth > 0) { "frameWidth must be positive: $frameWidth" }
        require(frameHeight > 0) { "frameHeight must be positive: $frameHeight" }
        require(targetWidth > 0) { "targetWidth must be positive: $targetWidth" }
        require(targetHeight > 0) { "targetHeight must be positive: $targetHeight" }

        val actualW = targetWidth.coerceAtMost(frameWidth)
        val actualH = targetHeight.coerceAtMost(frameHeight)

        val left = ((frameWidth - actualW) / 2).coerceAtLeast(0)
        val top = ((frameHeight - actualH) / 2).coerceAtLeast(0)

        return RoiBounds(
            left = left,
            top = top,
            width = actualW,
            height = actualH
        )
    }
}

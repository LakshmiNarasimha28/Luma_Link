package com.lumalink.harness

import android.content.Context
import android.util.Log
import android.util.Size
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

private const val TAG = "CameraCaptureManager"

/**
 * Manages CameraX lifecycle, preview rendering, and zero-stale-frame ImageAnalysis.
 *
 * BACKPRESSURE STRATEGY:
 * Uses ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST.
 * If frame decoding or metric computation takes longer than the frame interval (e.g. 33ms at 30 FPS),
 * intermediate frames are dropped at the camera HAL layer rather than accumulating in an unbounded
 * memory queue. This ensures the receiver is always analyzing the most current visual frame on the screen.
 */
class CameraCaptureManager(
    private val context: Context,
    private val lifecycleOwner: LifecycleOwner,
    private val onFrameCaptured: (AndroidCapturedFrame) -> Unit
) {
    private var cameraProvider: ProcessCameraProvider? = null
    private var camera: Camera? = null
    private var imageAnalysis: ImageAnalysis? = null
    private val analysisExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val frameSequence = AtomicLong(0)

    fun startCamera(previewView: PreviewView, targetResolution: Size = Size(1280, 720)) {
        val cameraProviderFuture = ProcessCameraProvider.getInstance(context)

        cameraProviderFuture.addListener({
            cameraProvider = cameraProviderFuture.get()

            // Preview use-case
            val preview = Preview.Builder().build().also {
                it.setSurfaceProvider(previewView.surfaceProvider)
            }

            // ImageAnalysis use-case with KEEP_ONLY_LATEST backpressure
            imageAnalysis = ImageAnalysis.Builder()
                .setTargetResolution(targetResolution)
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888)
                .build()
                .also { analysis ->
                    analysis.setAnalyzer(analysisExecutor) { imageProxy ->
                        processImageProxy(imageProxy)
                    }
                }

            val cameraSelector = CameraSelector.DEFAULT_BACK_CAMERA

            try {
                cameraProvider?.unbindAll()
                camera = cameraProvider?.bindToLifecycle(
                    lifecycleOwner,
                    cameraSelector,
                    preview,
                    imageAnalysis
                )
                Log.i(TAG, "CameraX bound successfully at resolution: $targetResolution")
            } catch (e: Exception) {
                Log.e(TAG, "CameraX binding failed: ${e.message}", e)
            }
        }, ContextCompat.getMainExecutor(context))
    }

    private fun processImageProxy(imageProxy: ImageProxy) {
        val arrivalTimeMs = System.currentTimeMillis()
        val seq = frameSequence.incrementAndGet()

        val capturedFrame = try {
            OpticalFrameAdapter.extractLuminancePlane(
                image = imageProxy,
                sequenceNumber = seq,
                timestampMs = arrivalTimeMs
            )
        } catch (e: Exception) {
            Log.e(TAG, "Frame extraction error: ${e.message}", e)
            null
        } finally {
            // CRITICAL: Immediately close imageProxy to release the hardware buffer
            // back to the CameraX HAL pipeline without waiting for downstream decode.
            imageProxy.close()
        }

        if (capturedFrame != null) {
            try {
                onFrameCaptured(capturedFrame)
            } catch (e: Exception) {
                Log.e(TAG, "Frame delivery error: ${e.message}", e)
            }
        }
    }

    fun getCameraControl() = camera?.cameraControl
    fun getCameraInfo() = camera?.cameraInfo

    fun stopCamera() {
        cameraProvider?.unbindAll()
        analysisExecutor.shutdown()
    }
}

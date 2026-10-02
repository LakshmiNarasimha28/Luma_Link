package com.lumalink.harness

import android.hardware.camera2.CaptureRequest
import androidx.annotation.OptIn
import androidx.camera.camera2.interop.Camera2CameraControl
import androidx.camera.camera2.interop.CaptureRequestOptions
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.CameraControl

/**
 * Camera2 Interop helper for controlled physical experiments (Experiment F: Focus & Exposure).
 *
 * RATIONALE:
 * Per Phase 4 Architecture Specification, CameraX is the primary abstraction.
 * Camera2 interop is utilized ONLY where low-level HAL controls (such as locking
 * Auto-Exposure or Auto-Focus against focus hunting during high-speed QR presentation)
 * are not directly exposed by high-level CameraX APIs.
 */
object Camera2InteropHelper {

    @OptIn(ExperimentalCamera2Interop::class)
    fun lockAutoExposure(cameraControl: CameraControl, locked: Boolean) {
        val camera2Control = Camera2CameraControl.from(cameraControl)
        val options = CaptureRequestOptions.Builder()
            .setCaptureRequestOption(CaptureRequest.CONTROL_AE_LOCK, locked)
            .build()
        camera2Control.setCaptureRequestOptions(options)
    }

    @OptIn(ExperimentalCamera2Interop::class)
    fun setAutoFocusMode(cameraControl: CameraControl, continuous: Boolean) {
        val camera2Control = Camera2CameraControl.from(cameraControl)
        val mode = if (continuous) {
            CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE
        } else {
            CaptureRequest.CONTROL_AF_MODE_AUTO
        }
        val options = CaptureRequestOptions.Builder()
            .setCaptureRequestOption(CaptureRequest.CONTROL_AF_MODE, mode)
            .build()
        camera2Control.setCaptureRequestOptions(options)
    }

    @OptIn(ExperimentalCamera2Interop::class)
    fun setExposureCompensation(cameraControl: CameraControl, evIndex: Int) {
        cameraControl.setExposureCompensationIndex(evIndex)
    }
}

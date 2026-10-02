package com.lumalink.harness

import android.graphics.Bitmap
import android.graphics.Color
import android.os.Bundle
import android.view.WindowManager
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import com.lumalink.harness.databinding.ActivitySenderBinding
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Android Sender Physical Display Harness.
 *
 * Provides controlled optical frame presentation with configurable parameters:
 * - Refresh intervals: 33ms (30Hz), 50ms (20Hz), 66ms (15Hz), 100ms (10Hz)
 * - Repetition counts: R=1, R=2, R=3
 * - Test sequences: Sequential (A, B, C, D) and Repetitive (A, A, B, B)
 * - Screen brightness forced to 1.0 (100% maximum luminance)
 */
class OpticalSenderDisplayActivity : AppCompatActivity() {

    private lateinit var binding: ActivitySenderBinding
    private val qrWriter = QRCodeWriter()

    // Configurable parameters
    private val intervalsMs = listOf(66L, 50L, 33L, 100L) // 15Hz, 20Hz, 30Hz, 10Hz
    private var intervalIndex = 0

    private val repetitionFactors = listOf(1, 2, 3)
    private var repetitionIndex = 0

    private val sequences = listOf(
        listOf("FRAME_A", "FRAME_B", "FRAME_C", "FRAME_D"),
        listOf("SYM_01", "SYM_02", "SYM_03", "SYM_04", "SYM_05", "SYM_06", "SYM_07", "SYM_08")
    )
    private var sequenceIndex = 0

    private var playbackJob: Job? = null
    private var isPlaying = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Lock maximum screen brightness for optical measurement
        val lp = window.attributes
        lp.screenBrightness = 1.0f
        window.attributes = lp
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        binding = ActivitySenderBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnCycleInterval.setOnClickListener {
            intervalIndex = (intervalIndex + 1) % intervalsMs.size
            updateButtonLabels()
        }

        binding.btnCycleRepetition.setOnClickListener {
            repetitionIndex = (repetitionIndex + 1) % repetitionFactors.size
            updateButtonLabels()
        }

        binding.btnCycleSequence.setOnClickListener {
            sequenceIndex = (sequenceIndex + 1) % sequences.size
            updateButtonLabels()
        }

        binding.btnTogglePlayback.setOnClickListener {
            if (isPlaying) {
                stopPlayback()
            } else {
                startPlayback()
            }
        }

        binding.btnBackToReceiver.setOnClickListener {
            finish()
        }

        updateButtonLabels()
        displaySingleFrame(sequences[sequenceIndex][0])
    }

    private fun updateButtonLabels() {
        val interval = intervalsMs[intervalIndex]
        val hz = 1000 / interval
        binding.btnCycleInterval.text = "${interval}ms (${hz}Hz)"

        val rep = repetitionFactors[repetitionIndex]
        binding.btnCycleRepetition.text = "Rep: R=$rep"

        binding.btnCycleSequence.text = if (sequenceIndex == 0) "Seq: A-B-C-D" else "Seq: Fountain (8)"
    }

    private fun startPlayback() {
        isPlaying = true
        binding.btnTogglePlayback.text = "Stop Display"

        val interval = intervalsMs[intervalIndex]
        val rep = repetitionFactors[repetitionIndex]
        val currentSeq = sequences[sequenceIndex]

        playbackJob = lifecycleScope.launch {
            var frameIdx = 0
            while (isActive && isPlaying) {
                val payload = currentSeq[frameIdx % currentSeq.size]
                val bitmap = generateQrBitmap(payload, 512)
                binding.ivQrDisplay.setImageBitmap(bitmap)

                binding.tvDisplayStatus.text = String.format(
                    "Frame: %d/%d (%s) | Interval: %dms | Rep: R=%d",
                    (frameIdx % currentSeq.size) + 1, currentSeq.size, payload, interval, rep
                )

                // Hold each visual frame for R intervals
                delay(interval * rep)
                frameIdx++
            }
        }
    }

    private fun stopPlayback() {
        isPlaying = false
        playbackJob?.cancel()
        playbackJob = null
        binding.btnTogglePlayback.text = "Start Display"
    }

    private fun displaySingleFrame(payload: String) {
        val bitmap = generateQrBitmap(payload, 512)
        binding.ivQrDisplay.setImageBitmap(bitmap)
        binding.tvDisplayStatus.text = "Frame: $payload (Paused)"
    }

    private fun generateQrBitmap(content: String, sizePx: Int): Bitmap {
        val hints = mapOf(
            EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
            EncodeHintType.MARGIN to 2
        )
        val bitMatrix = qrWriter.encode(content, BarcodeFormat.QR_CODE, sizePx, sizePx, hints)
        val bitmap = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.RGB_565)

        for (x in 0 until sizePx) {
            for (y in 0 until sizePx) {
                bitmap.setPixel(x, y, if (bitMatrix.get(x, y)) Color.BLACK else Color.WHITE)
            }
        }
        return bitmap
    }

    override fun onDestroy() {
        super.onDestroy()
        stopPlayback()
    }
}

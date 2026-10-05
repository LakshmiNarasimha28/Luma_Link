package com.lumalink.harness

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.NotFoundException
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.lumalink.harness.crypto.DecryptionException
import com.lumalink.harness.crypto.PreProvisionedSessionStore
import com.lumalink.harness.crypto.ReplayException
import com.lumalink.harness.crypto.TestFixtureSessions
import com.lumalink.harness.databinding.ActivityReceiverBinding
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Android-First Optical Measurement Receiver Harness.
 *
 * RESEARCH & MEASUREMENT TOOL (Section 7).
 * Displays real-time measurement metrics:
 * - Frame: seq, timestamp, Camera FPS, Decoder Throughput, dimensions, ROI, jitter
 * - QR: detected, latency (real elapsed time for both success and NotFoundException), ECC, payload bytes
 * - Duplicate Tier: camera duplicate, visual repetition, packet duplicate, novel
 * - Channel: received, dropped, success rate
 * - Goodput: Level 1 Codec, Level 2 Optical, Level 3 Verified E2E
 */
class OpticalMeasurementReceiverActivity : AppCompatActivity() {

    private lateinit var binding: ActivityReceiverBinding
    private lateinit var cameraCaptureManager: CameraCaptureManager

    // QR Reader (Pure Java, Zero C++/Rust/ML)
    private val qrReader = MultiFormatReader().apply {
        setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(com.google.zxing.BarcodeFormat.QR_CODE)))
    }

    // Dedicated decoder worker (decoupled from CameraX HAL buffer acquisition)
    private val decoderExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val pendingDecodeFrame = AtomicReference<AndroidCapturedFrame?>()
    private val isDecoding = AtomicBoolean(false)

    // Configurable Center ROI (aligned with 280dp targeting reticle on screen)
    var roiWidth: Int = CenterRoiHelper.DEFAULT_ROI_SIZE
    var roiHeight: Int = CenterRoiHelper.DEFAULT_ROI_SIZE

    // Decoupled interval & FPS trackers
    private val cameraIntervalTracker = IntervalTracker(60)
    private val decoderIntervalTracker = IntervalTracker(60)
    private val duplicateClassifier = DuplicateClassifier(cameraDuplicateThresholdMs = 40L)

    // Phase 5C.3: Canonical LT/Fountain Decoder
    private val lumaLtDecoder = com.lumalink.harness.fec.LumaLtDecoder(defaultSymbolSize = 64)

    // Optical metrics counters
    private var startTimeMs: Long = 0L
    private var totalCameraFrames: Long = 0L
    private var totalDecodesAttempted: Long = 0L
    private var totalQrDetected: Long = 0L
    private var totalQrFailed: Long = 0L
    private var totalDecodeLatencyMs: Double = 0.0
    private var totalDecodedBytes: Long = 0L
    private var lastFrameWidth: Int = 1280
    private var lastFrameHeight: Int = 720

    private var isAfAeLocked = false

    private val cameraPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { isGranted ->
        if (isGranted) {
            setupCamera()
        } else {
            Toast.makeText(this, "Camera permission required for optical harness", Toast.LENGTH_LONG).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        binding = ActivityReceiverBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // Phase 5C.2: Register pre-provisioned test sessions for physical verification
        TestFixtureSessions.registerTestSessions()

        cameraCaptureManager = CameraCaptureManager(
            context = this,
            lifecycleOwner = this,
            onFrameCaptured = { frame -> onFrameCaptured(frame) }
        )

        binding.btnToggleAfAe.setOnClickListener {
            toggleAfAeLock()
        }

        binding.btnResetMetrics.setOnClickListener {
            resetMetrics()
        }

        binding.btnLaunchSender.setOnClickListener {
            startActivity(Intent(this, OpticalSenderDisplayActivity::class.java))
        }

        binding.btnRunCryptoSpike.setOnClickListener {
            val result = com.lumalink.harness.crypto.AndroidCryptoCompatibilityRunner.runDiagnostics()
            val scrollView = android.widget.ScrollView(this).apply {
                val tv = android.widget.TextView(this@OpticalMeasurementReceiverActivity).apply {
                    text = result.report
                    setPadding(32, 32, 32, 32)
                    typeface = android.graphics.Typeface.MONOSPACE
                    textSize = 10f
                    setTextIsSelectable(true)
                }
                addView(tv)
            }
            androidx.appcompat.app.AlertDialog.Builder(this)
                .setTitle("Crypto Spike Results")
                .setView(scrollView)
                .setPositiveButton("Close", null)
                .setNeutralButton("Copy to Clipboard") { _, _ ->
                    val clipboard = getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                    val clip = android.content.ClipData.newPlainText("LumaLink Crypto Spike", result.report)
                    clipboard.setPrimaryClip(clip)
                    Toast.makeText(this, "Report copied to clipboard!", Toast.LENGTH_SHORT).show()
                }
                .show()
        }

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            setupCamera()
        } else {
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    private fun setupCamera() {
        cameraCaptureManager.startCamera(binding.previewView)
    }

    private fun toggleAfAeLock() {
        val control = cameraCaptureManager.getCameraControl() ?: return
        isAfAeLocked = !isAfAeLocked
        Camera2InteropHelper.lockAutoExposure(control, isAfAeLocked)
        Camera2InteropHelper.setAutoFocusMode(control, !isAfAeLocked)
        binding.btnToggleAfAe.text = if (isAfAeLocked) "Unlock AF/AE" else "Lock AF/AE"
        Toast.makeText(this, if (isAfAeLocked) "AF & AE Locked" else "AF & AE Auto", Toast.LENGTH_SHORT).show()
    }

    private fun resetMetrics() {
        totalCameraFrames = 0
        totalDecodesAttempted = 0
        totalQrDetected = 0
        totalQrFailed = 0
        totalDecodeLatencyMs = 0.0
        totalDecodedBytes = 0
        startTimeMs = 0
        cameraIntervalTracker.reset()
        decoderIntervalTracker.reset()
        duplicateClassifier.reset()
        PreProvisionedSessionStore.get(TestFixtureSessions.GOLDEN_SESSION_ID_BYTES)?.replayProtector?.reset()
        lumaLtDecoder.reset()
        pendingDecodeFrame.set(null)
        updateHudUI(
            cameraFps = 0.0,
            decoderFps = 0.0,
            jitter = 0.0,
            latencyMs = 0.0,
            classification = "NONE",
            payloadBytes = 0,
            version = "-",
            ecc = "-",
            frameWidth = lastFrameWidth,
            frameHeight = lastFrameHeight,
            roiWidth = roiWidth,
            roiHeight = roiHeight,
            protocolStatus = "Idle"
        )
    }

    private fun onFrameCaptured(frame: AndroidCapturedFrame) {
        val now = frame.timestampMs
        if (startTimeMs == 0L) startTimeMs = now

        totalCameraFrames++
        lastFrameWidth = frame.width
        lastFrameHeight = frame.height

        // 1. Immediately record camera hardware arrival metrics (HAL decoupled)
        val cameraFps = cameraIntervalTracker.recordTimestamp(now)
        val cameraJitter = cameraIntervalTracker.computeJitter()

        // 2. Dispatch to dedicated decoder worker preserving STRATEGY_KEEP_ONLY_LATEST
        pendingDecodeFrame.set(frame)
        scheduleDecode(cameraFps, cameraJitter)
    }

    private fun scheduleDecode(cameraFps: Double, cameraJitter: Double) {
        if (isDecoding.compareAndSet(false, true)) {
            decoderExecutor.execute {
                try {
                    while (true) {
                        val frameToDecode = pendingDecodeFrame.getAndSet(null) ?: break
                        decodeFrame(frameToDecode, cameraFps, cameraJitter)
                    }
                } finally {
                    isDecoding.set(false)
                    if (pendingDecodeFrame.get() != null) {
                        scheduleDecode(cameraFps, cameraJitter)
                    }
                }
            }
        }
    }

    private fun decodeFrame(
        frame: AndroidCapturedFrame,
        cameraFps: Double,
        cameraJitter: Double
    ) {
        // 1. Compute Center ROI (480x480 region corresponding to targeting reticle)
        val roi = CenterRoiHelper.computeCenterRoi(frame.width, frame.height, roiWidth, roiHeight)

        val source = PlanarYUVLuminanceSource(
            frame.data,
            frame.width,
            frame.height,
            roi.left,
            roi.top,
            roi.width,
            roi.height,
            false
        )
        val bitmap = BinaryBitmap(HybridBinarizer(source))

        val decodeStartNs = System.nanoTime()
        totalDecodesAttempted++
        val decoderFps = decoderIntervalTracker.recordTimestamp(System.currentTimeMillis())

        try {
            val result = qrReader.decodeWithState(bitmap)
            val latencyMs = (System.nanoTime() - decodeStartNs) / 1_000_000.0

            totalQrDetected++
            totalDecodeLatencyMs += latencyMs

            // Phase 5C.1: Extract exact binary byte segments (DO NOT use rawBytes or text)
            val binaryPayload = QrBytePayloadExtractor.extract(result)
            val payloadBytes = binaryPayload?.size ?: 0
            totalDecodedBytes += payloadBytes

            var protocolStatus: String
            var packetId: String
            var rawClassificationBytes: ByteArray

            if (binaryPayload != null) {
                try {
                    val packet = LumaPacketCodec.decode(binaryPayload)
                    // Valid LumaLink packet framing & CRC: identify session and decrypt
                    val securityContext = PreProvisionedSessionStore.get(packet.sessionId)
                    if (securityContext != null) {
                        try {
                            val plaintext = securityContext.decryptFromWirePayload(
                                blockIndex = packet.blockIndex,
                                symbolId = packet.symbolId,
                                wirePayload = packet.payload,
                                packetTypeCode = packet.packetType,
                                flags = packet.flags,
                                checkReplay = true,
                                direction = "sender"
                            )

                            // Phase 5C.3: Ingest authenticated symbol into canonical LT/Fountain decoder
                            lumaLtDecoder.addSymbol(
                                blockIndex = packet.blockIndex,
                                symbolId = packet.symbolId,
                                k = packet.k,
                                data = plaintext,
                                degree = packet.degree
                            )
                            val isBlockComplete = lumaLtDecoder.isBlockComplete(packet.blockIndex)
                            val recoveredCount = lumaLtDecoder.getBlockDecoder(packet.blockIndex)?.recoveredSymbolCount ?: 0

                            val fecStatus = if (isBlockComplete) {
                                "FEC: $recoveredCount/${packet.k} (100% COMPLETE)"
                            } else {
                                "FEC: $recoveredCount/${packet.k}"
                            }

                            protocolStatus = "LUMA | ${packet.packetTypeName} | ${packet.rawBytes.size} B | CRC OK | DECRYPT OK (${plaintext.size} B) | B=${packet.blockIndex} | SYM=${packet.symbolId} | $fecStatus"
                            packetId = "${packet.sessionIdUuid.take(8)}-${packet.blockIndex}-${packet.symbolId}"
                        } catch (e: ReplayException) {
                            protocolStatus = "LUMA | ${packet.packetTypeName} | ${packet.rawBytes.size} B | CRC OK | DECRYPT FAIL (REPLAY) | B=${packet.blockIndex} | SYM=${packet.symbolId}"
                            packetId = "replay-${packet.blockIndex}-${packet.symbolId}-${frame.timestampMs}"
                        } catch (e: DecryptionException) {
                            protocolStatus = "LUMA | ${packet.packetTypeName} | ${packet.rawBytes.size} B | CRC OK | DECRYPT FAIL (AUTH) | B=${packet.blockIndex} | SYM=${packet.symbolId}"
                            packetId = "auth-fail-${packet.blockIndex}-${packet.symbolId}-${frame.timestampMs}"
                        } catch (e: Exception) {
                            protocolStatus = "LUMA | ${packet.packetTypeName} | ${packet.rawBytes.size} B | CRC OK | DECRYPT FAIL (ERROR)"
                            packetId = "decrypt-error-${frame.timestampMs}"
                        }
                    } else {
                        protocolStatus = "LUMA | ${packet.packetTypeName} | ${packet.rawBytes.size} B | CRC OK | SESSION UNKNOWN | B=${packet.blockIndex} | SYM=${packet.symbolId}"
                        packetId = "unknown-session-${packet.sessionIdUuid.take(8)}-${frame.timestampMs}"
                    }
                    rawClassificationBytes = packet.rawBytes
                } catch (e: ChecksumMismatchException) {
                    protocolStatus = "INVALID (CRC FAIL)"
                    packetId = "crc-fail-${frame.timestampMs}"
                    rawClassificationBytes = binaryPayload
                } catch (e: MalformedPacketException) {
                    protocolStatus = "INVALID (BAD MAGIC)"
                    packetId = "bad-magic-${frame.timestampMs}"
                    rawClassificationBytes = binaryPayload
                } catch (e: TruncatedPacketException) {
                    protocolStatus = "INVALID (TRUNCATED)"
                    packetId = "truncated-${frame.timestampMs}"
                    rawClassificationBytes = binaryPayload
                } catch (e: TrailingDataException) {
                    protocolStatus = "INVALID (TRAILING DATA)"
                    packetId = "trailing-${frame.timestampMs}"
                    rawClassificationBytes = binaryPayload
                } catch (e: UnsupportedProtocolVersionException) {
                    protocolStatus = "INVALID (UNSUPPORTED VERSION)"
                    packetId = "bad-version-${frame.timestampMs}"
                    rawClassificationBytes = binaryPayload
                } catch (e: InvalidPacketTypeException) {
                    protocolStatus = "INVALID (BAD TYPE)"
                    packetId = "bad-type-${frame.timestampMs}"
                    rawClassificationBytes = binaryPayload
                } catch (e: LumaPacketException) {
                    protocolStatus = "INVALID (MALFORMED)"
                    packetId = "malformed-${frame.timestampMs}"
                    rawClassificationBytes = binaryPayload
                }
            } else {
                protocolStatus = "INVALID (NO BYTE SEGMENT)"
                packetId = result.text.ifEmpty { "no-byte-segment-${frame.timestampMs}" }
                rawClassificationBytes = ByteArray(0)
            }

            // Three-Tier Duplicate Classification
            val classification = duplicateClassifier.classify(
                rawPayload = rawClassificationBytes,
                packetId = packetId,
                timestampMs = frame.timestampMs
            )

            runOnUiThread {
                updateHudUI(
                    cameraFps = cameraFps,
                    decoderFps = decoderFps,
                    jitter = cameraJitter,
                    latencyMs = latencyMs,
                    classification = classification,
                    payloadBytes = payloadBytes,
                    version = "Auto",
                    ecc = "M",
                    frameWidth = frame.width,
                    frameHeight = frame.height,
                    roiWidth = roi.width,
                    roiHeight = roi.height,
                    protocolStatus = protocolStatus
                )
            }
        } catch (e: NotFoundException) {
            val latencyMs = (System.nanoTime() - decodeStartNs) / 1_000_000.0
            totalQrFailed++
            totalDecodeLatencyMs += latencyMs

            runOnUiThread {
                updateHudUI(
                    cameraFps = cameraFps,
                    decoderFps = decoderFps,
                    jitter = cameraJitter,
                    latencyMs = latencyMs, // Real measured elapsed latency even on search miss
                    classification = "NOT_DETECTED",
                    payloadBytes = 0,
                    version = "-",
                    ecc = "-",
                    frameWidth = frame.width,
                    frameHeight = frame.height,
                    roiWidth = roi.width,
                    roiHeight = roi.height,
                    protocolStatus = "Searching..."
                )
            }
        } finally {
            qrReader.reset()
        }
    }

    private fun updateHudUI(
        cameraFps: Double,
        decoderFps: Double,
        jitter: Double,
        latencyMs: Double,
        classification: String,
        payloadBytes: Int,
        version: String,
        ecc: String,
        frameWidth: Int,
        frameHeight: Int,
        roiWidth: Int,
        roiHeight: Int,
        protocolStatus: String = "Idle"
    ) {
        binding.tvFrameMetrics.text = String.format(
            "Frame: Seq #%d | Cam: %.1f FPS (Dec: %.1f) | %dx%d (ROI %dx%d) | Jitter: %.1f ms",
            totalCameraFrames, cameraFps, decoderFps, frameWidth, frameHeight, roiWidth, roiHeight, jitter
        )

        binding.tvQrMetrics.text = String.format(
            "QR: %s | Latency: %.1f ms | Size: %d B | Ver: %s | ECC: %s",
            if (payloadBytes > 0) "Detected" else "Searching...",
            latencyMs, payloadBytes, version, ecc
        )

        binding.tvProtocolMetrics.text = "Protocol: $protocolStatus"

        binding.tvDuplicateClassification.text = "Classification: $classification"

        val totalDecodes = totalQrDetected + totalQrFailed
        val rate = if (totalDecodes > 0) (totalQrDetected.toDouble() / totalDecodes) * 100.0 else 0.0

        binding.tvChannelMetrics.text = String.format(
            "Channel: Rx: %d | Novel: %d | CamDup: %d | Rep: %d | Rate: %.1f%%",
            totalCameraFrames,
            duplicateClassifier.novelPackets,
            duplicateClassifier.cameraDuplicates,
            duplicateClassifier.frameRepetitions,
            rate
        )

        // Three Performance Layers (Phase 4 §11 Specification):
        // Level 1: Software Codec CPU Throughput (decoded bytes / CPU decode time)
        // Level 2: Physical Optical Channel Goodput (novel payload bytes / wall-clock time)
        // Level 3: End-to-End Verified Plaintext File Goodput (strictly requires SHA-256 verified file match).
        // For the mock-symbol physical harness, Level 3 is strictly N/A (no fake/mirrored L3).
        val elapsedSec = if (startTimeMs > 0) (System.currentTimeMillis() - startTimeMs) / 1000.0 else 0.0
        val goodput = GoodputCalculator.computeGoodput(
            totalDecodedBytes = totalDecodedBytes,
            totalDecodeLatencyMs = totalDecodeLatencyMs,
            uniquePayloadBytesDelivered = duplicateClassifier.uniquePayloadBytesDelivered,
            elapsedDurationSec = elapsedSec,
            verifiedFileBytes = 0L, // No real file transfer in mock physical harness
            verifiedTransferDurationSec = 0.0
        )

        binding.tvGoodputMetrics.text = goodput.formatHudString()
    }

    override fun onDestroy() {
        super.onDestroy()
        cameraCaptureManager.stopCamera()
        decoderExecutor.shutdownNow()
    }
}

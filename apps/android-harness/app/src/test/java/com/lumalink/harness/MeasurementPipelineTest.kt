package com.lumalink.harness

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class MeasurementPipelineTest {

    // =========================================================================
    // 1. Center ROI Tests
    // =========================================================================

    @Test
    fun testCenterRoiAt720p() {
        // Standard 720p frame: 1280x720, target 480x480
        val roi = CenterRoiHelper.computeCenterRoi(
            frameWidth = 1280,
            frameHeight = 720,
            targetWidth = 480,
            targetHeight = 480
        )

        assertEquals(400, roi.left)
        assertEquals(120, roi.top)
        assertEquals(480, roi.width)
        assertEquals(480, roi.height)

        // Verify exact geometric centering
        val centerX = roi.left + roi.width / 2
        val centerY = roi.top + roi.height / 2
        assertEquals(1280 / 2, centerX)
        assertEquals(720 / 2, centerY)

        // Verify pixel reduction: 230,400 vs 921,600 (exactly 75% reduction)
        val originalPixels = 1280 * 720
        val roiPixels = roi.width * roi.height
        assertEquals(921600, originalPixels)
        assertEquals(230400, roiPixels)
        assertEquals(0.25, roiPixels.toDouble() / originalPixels, 0.001)
    }

    @Test
    fun testCenterRoiClampedWhenFrameSmallerThanTarget() {
        // Edge case: frame is smaller than 480x480 (e.g. 320x240)
        val roi = CenterRoiHelper.computeCenterRoi(
            frameWidth = 320,
            frameHeight = 240,
            targetWidth = 480,
            targetHeight = 480
        )

        assertEquals(0, roi.left)
        assertEquals(0, roi.top)
        assertEquals(320, roi.width)
        assertEquals(240, roi.height)
    }

    @Test
    fun testCenterRoiCustomDimensions() {
        val roi = CenterRoiHelper.computeCenterRoi(
            frameWidth = 1920,
            frameHeight = 1080,
            targetWidth = 600,
            targetHeight = 600
        )

        assertEquals((1920 - 600) / 2, roi.left)
        assertEquals((1080 - 600) / 2, roi.top)
        assertEquals(600, roi.width)
        assertEquals(600, roi.height)
    }

    // =========================================================================
    // 2. Interval & FPS Tracking Tests (Camera vs Decoder Decoupling)
    // =========================================================================

    @Test
    fun testCameraArrivalFpsTracking() {
        val tracker = IntervalTracker(maxWindowSize = 60)

        // Simulate 30 frames arriving at steady 33.33ms intervals (30 FPS)
        var t = 1000L
        for (i in 0 until 30) {
            tracker.recordTimestamp(t)
            t += 33L // approx 30.3 FPS
        }

        val fps = tracker.computeFps()
        assertTrue("FPS should be around 30.3: actual=$fps", fps in 30.0..31.0)
        assertEquals(29, tracker.getSampleCount())
        assertTrue("Jitter should be near 0 for uniform timestamps", tracker.computeJitter() < 0.5)
    }

    @Test
    fun testDecoupledCameraAndDecoderFps() {
        val cameraTracker = IntervalTracker(60)
        val decoderTracker = IntervalTracker(60)

        // Camera arrives at 30 FPS (~33ms)
        var camT = 1000L
        for (i in 0 until 30) {
            cameraTracker.recordTimestamp(camT)
            camT += 33L
        }

        // Decoder processes at 10 FPS (~100ms)
        var decT = 1000L
        for (i in 0 until 10) {
            decoderTracker.recordTimestamp(decT)
            decT += 100L
        }

        val camFps = cameraTracker.computeFps()
        val decFps = decoderTracker.computeFps()

        // Verify independent tracking
        assertTrue("Camera FPS should be ~30.3: actual=$camFps", camFps in 30.0..31.0)
        assertTrue("Decoder FPS should be ~10.0: actual=$decFps", decFps in 9.8..10.2)
    }

    // =========================================================================
    // 3. Duplicate Classification Tests
    // =========================================================================

    @Test
    fun testThreeTierDuplicateClassification() {
        val classifier = DuplicateClassifier(cameraDuplicateThresholdMs = 40L)

        val payloadA = "FRAME_A".toByteArray(Charsets.UTF_8)
        val payloadB = "FRAME_B".toByteArray(Charsets.UTF_8)

        // 1. First presentation of A -> NOVEL
        val c1 = classifier.classify(payloadA, "FRAME_A", 1000L)
        assertEquals("NOVEL", c1)
        assertEquals(1, classifier.novelPackets)
        assertEquals(7, classifier.uniquePayloadBytesDelivered)

        // 2. Camera oversampling within 33ms (< 40ms) -> CAMERA_DUPLICATE
        val c2 = classifier.classify(payloadA, "FRAME_A", 1033L)
        assertEquals("CAMERA_DUPLICATE", c2)
        assertEquals(1, classifier.cameraDuplicates)

        // 3. Sender visual repetition at 66ms (> 40ms) -> FRAME_REPETITION
        val c3 = classifier.classify(payloadA, "FRAME_A", 1100L)
        assertEquals("FRAME_REPETITION", c3)
        assertEquals(1, classifier.frameRepetitions)

        // 4. Switch to new packet B -> NOVEL
        val c4 = classifier.classify(payloadB, "FRAME_B", 1200L)
        assertEquals("NOVEL", c4)
        assertEquals(2, classifier.novelPackets)

        // 5. Fountain retransmission of packet A -> PACKET_DUPLICATE
        val c5 = classifier.classify(payloadA, "FRAME_A", 1300L)
        assertEquals("PACKET_DUPLICATE", c5)
        assertEquals(1, classifier.packetDuplicates)
    }

    // =========================================================================
    // 4. Decoupled Decoder Worker Concurrency & KEEP_ONLY_LATEST
    // =========================================================================

    @Test
    fun testDecoupledQueueDropsStaleFramesPreservingLatest() {
        val decoderExecutor = Executors.newSingleThreadExecutor()
        val pendingFrame = AtomicReference<String?>()
        val isDecoding = AtomicBoolean(false)
        val decodedList = mutableListOf<String>()
        val totalCameraFrames = AtomicInteger(0)
        val latch = CountDownLatch(1)

        fun scheduleDecode() {
            if (isDecoding.compareAndSet(false, true)) {
                decoderExecutor.execute {
                    try {
                        while (true) {
                            val item = pendingFrame.getAndSet(null) ?: break
                            // Simulate 60ms decode duration
                            Thread.sleep(60)
                            synchronized(decodedList) {
                                decodedList.add(item)
                            }
                        }
                    } finally {
                        isDecoding.set(false)
                        if (pendingFrame.get() != null) {
                            scheduleDecode()
                        } else {
                            latch.countDown()
                        }
                    }
                }
            }
        }

        // Simulate 8 camera frames arriving rapidly (every 10ms)
        for (i in 1..8) {
            totalCameraFrames.incrementAndGet()
            pendingFrame.set("Frame_$i")
            scheduleDecode()
            Thread.sleep(10)
        }

        // Wait for decoder worker to complete
        assertTrue("Decoder should complete in 1 second", latch.await(1, TimeUnit.SECONDS))
        decoderExecutor.shutdown()

        assertEquals("All 8 camera frames arrived at camera HAL layer", 8, totalCameraFrames.get())

        synchronized(decodedList) {
            // Because decode takes 60ms and frames arrive every 10ms,
            // intermediate frames are dropped and only the latest is picked up.
            assertTrue("Should process fewer frames than total arrived", decodedList.size < 8)
            assertEquals("First frame must be Frame_1", "Frame_1", decodedList.first())
            assertEquals("Last frame must be the freshest Frame_8", "Frame_8", decodedList.last())
        }
    }

    // =========================================================================
    // 5. Three Performance Layers & L3 Non-Equivalence Tests
    // =========================================================================

    @Test
    fun testL3DoesNotEqualL2MerelyBecauseL2IsNonZero() {
        // Simulate physical FOUNTAIN_8 run where 8 novel packets (144 bytes) are delivered
        // across 1.0 second of wall-clock time with 200ms total decode CPU time
        val goodput = GoodputCalculator.computeGoodput(
            totalDecodedBytes = 144L,
            totalDecodeLatencyMs = 200.0,
            uniquePayloadBytesDelivered = 144L,
            elapsedDurationSec = 1.0,
            verifiedFileBytes = 0L, // Mock harness transmits mock strings, not a verified file
            verifiedTransferDurationSec = 0.0
        )

        // L1 Codec Throughput: 144 B / 0.200s = 720 B/s
        assertEquals(720.0, goodput.l1CodecBps, 0.001)

        // L2 Optical Goodput: 144 B / 1.0s = 144 B/s
        assertEquals(144.0, goodput.l2OpticalBps, 0.001)
        assertTrue("L2 Optical goodput must be strictly positive", goodput.l2OpticalBps > 0.0)

        // CRITICAL INVARIANT: L3 E2E Goodput must NOT equal L2 simply because L2 > 0.
        // It must be null/unverified because no real file transfer or SHA-256 verification occurred.
        assertEquals("L3 E2E goodput must be null for mock runs", null, goodput.l3E2EBps)
        assertTrue("Verified file transfer must not be flagged active", !goodput.isVerifiedTransferActive)

        // HUD formatting verification
        val hudText = goodput.formatHudString()
        assertTrue("HUD must explicitly indicate L3 is N/A / Mock", hudText.contains("L3 E2E: N/A (Mock/No SHA-256)"))
        assertTrue("HUD must not report 144 B/s for L3", !hudText.contains("L3 E2E: 144 B/s"))
    }

    @Test
    fun testL3OnlyComputedWhenVerifiedFileTransferIsActive() {
        // Simulate a complete end-to-end file transfer (1000-byte file verified in 2.5s)
        val goodput = GoodputCalculator.computeGoodput(
            totalDecodedBytes = 2000L,
            totalDecodeLatencyMs = 500.0,
            uniquePayloadBytesDelivered = 1500L,
            elapsedDurationSec = 3.0,
            verifiedFileBytes = 1000L,
            verifiedTransferDurationSec = 2.5
        )

        assertEquals(4000.0, goodput.l1CodecBps, 0.001)
        assertEquals(500.0, goodput.l2OpticalBps, 0.001)
        val l3Value = goodput.l3E2EBps
        assertEquals(400.0, l3Value!!, 0.001)
        assertTrue(goodput.isVerifiedTransferActive)

        // Invariant: L3 <= L2 <= L1
        assertTrue("L3 must be <= L2", l3Value <= goodput.l2OpticalBps)
        assertTrue("L2 must be <= L1", goodput.l2OpticalBps <= goodput.l1CodecBps)

        val hudText = goodput.formatHudString()
        assertTrue("HUD must display verified L3 rate", hudText.contains("L3 E2E: 400 B/s"))
    }
}

package com.lumalink.harness.session

import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * Unit tests verifying [SessionManifestStore]:
 * - Case A: Novel session registration
 * - Case B: Idempotent duplicate registration
 * - Case C: Complete manifest conflict detection (every field validated)
 * - Original manifest preservation on conflict
 * - Multi-session isolation
 */
class SessionManifestStoreTest {

    private val sessionIdA = ByteArray(16) { 0x0A }
    private val sessionIdB = ByteArray(16) { 0x0B }
    private val pubKeyA = ByteArray(32) { 0x11 }
    private val pubKeyB = ByteArray(32) { 0x22 }
    private val shaA = "a".repeat(64)
    private val shaB = "b".repeat(64)

    private val manifestA = LumaSessionAnnouncement(
        sessionId = sessionIdA,
        mode = "quick",
        senderDeviceId = "device-alpha",
        senderPublicKey = pubKeyA,
        fileName = "alpha-doc.pdf",
        fileSize = 4096L,
        sha256Digest = shaA,
        symbolSize = 64,
        symbolsPerBlock = 16,
        totalBlocks = 4,
        timestamp = 1728120000000L
    )

    @Before
    fun setUp() {
        SessionManifestStore.clear()
    }

    @Test
    fun test1_manifestRegistersSuccessfully() {
        val result = SessionManifestStore.register(manifestA)
        assertEquals(ManifestRegistrationResult.Accepted, result)
        assertTrue(SessionManifestStore.contains(sessionIdA))
        assertEquals(manifestA, SessionManifestStore.get(sessionIdA))
        assertEquals(1, SessionManifestStore.count())

        val fileManifest = SessionManifestStore.getManifest(sessionIdA)
        assertNotNull(fileManifest)
        assertEquals("alpha-doc.pdf", fileManifest!!.fileName)
        assertEquals(4096L, fileManifest.fileSize)
    }

    @Test
    fun test2_identicalManifestArrivesAgain_isIdempotent() {
        // First registration
        assertEquals(ManifestRegistrationResult.Accepted, SessionManifestStore.register(manifestA))

        // Identical duplicate registration (defensive copy with same contents)
        val duplicateA = manifestA.copy(sessionId = sessionIdA.copyOf(), senderPublicKey = pubKeyA.copyOf())
        val duplicateResult = SessionManifestStore.register(duplicateA)

        assertEquals(ManifestRegistrationResult.DuplicateAccepted, duplicateResult)
        assertEquals(1, SessionManifestStore.count())
        assertEquals(manifestA, SessionManifestStore.get(sessionIdA))
    }

    @Test
    fun test3_conflictingFileName_rejectedAndOriginalPreserved() {
        SessionManifestStore.register(manifestA)

        val conflicting = manifestA.copy(fileName = "tampered-doc.pdf")
        val exception = assertThrows(ConflictingManifestException::class.java) {
            SessionManifestStore.register(conflicting)
        }
        assertTrue(exception.message!!.contains("fileName mismatch"))

        // Original preserved
        val current = SessionManifestStore.get(sessionIdA)
        assertNotNull(current)
        assertEquals("alpha-doc.pdf", current!!.fileName)
    }

    @Test
    fun test4_conflictingSha256_rejectedAndOriginalPreserved() {
        SessionManifestStore.register(manifestA)

        val conflicting = manifestA.copy(sha256Digest = shaB)
        val exception = assertThrows(ConflictingManifestException::class.java) {
            SessionManifestStore.register(conflicting)
        }
        assertTrue(exception.message!!.contains("sha256Digest mismatch"))

        val current = SessionManifestStore.get(sessionIdA)
        assertNotNull(current)
        assertEquals(shaA, current!!.sha256Digest)
    }

    @Test
    fun test5_conflictingFecParameters_rejected() {
        SessionManifestStore.register(manifestA)

        // Conflict 1: symbolSize
        assertThrows(ConflictingManifestException::class.java) {
            SessionManifestStore.register(manifestA.copy(symbolSize = 128))
        }

        // Conflict 2: symbolsPerBlock
        assertThrows(ConflictingManifestException::class.java) {
            SessionManifestStore.register(manifestA.copy(symbolsPerBlock = 32))
        }

        // Conflict 3: totalBlocks
        assertThrows(ConflictingManifestException::class.java) {
            SessionManifestStore.register(manifestA.copy(totalBlocks = 8))
        }

        // Original intact
        val current = SessionManifestStore.get(sessionIdA)!!
        assertEquals(64, current.symbolSize)
        assertEquals(16, current.symbolsPerBlock)
        assertEquals(4, current.totalBlocks)
    }

    @Test
    fun testConflictDetection_allOtherFields() {
        SessionManifestStore.register(manifestA)

        // Conflict: mode
        assertThrows(ConflictingManifestException::class.java) {
            SessionManifestStore.register(manifestA.copy(mode = "private"))
        }

        // Conflict: fileSize
        assertThrows(ConflictingManifestException::class.java) {
            SessionManifestStore.register(manifestA.copy(fileSize = 8192L))
        }

        // Conflict: senderPublicKey
        assertThrows(ConflictingManifestException::class.java) {
            SessionManifestStore.register(manifestA.copy(senderPublicKey = pubKeyB))
        }

        // Conflict: senderDeviceId
        assertThrows(ConflictingManifestException::class.java) {
            SessionManifestStore.register(manifestA.copy(senderDeviceId = "device-rogue"))
        }

        // Conflict: timestamp
        assertThrows(ConflictingManifestException::class.java) {
            SessionManifestStore.register(manifestA.copy(timestamp = 999999999999L))
        }
    }

    @Test
    fun testMultiSessionIsolation() {
        val manifestB = LumaSessionAnnouncement(
            sessionId = sessionIdB,
            mode = "private",
            senderDeviceId = "device-beta",
            senderPublicKey = pubKeyB,
            fileName = "beta-data.bin",
            fileSize = 10000L,
            sha256Digest = shaB,
            symbolSize = 64,
            symbolsPerBlock = 16,
            totalBlocks = 10,
            timestamp = 1728120005000L
        )

        assertEquals(ManifestRegistrationResult.Accepted, SessionManifestStore.register(manifestA))
        assertEquals(ManifestRegistrationResult.Accepted, SessionManifestStore.register(manifestB))
        assertEquals(2, SessionManifestStore.count())

        // Ensure session A and session B do not cross-contaminate
        assertEquals(manifestA, SessionManifestStore.get(sessionIdA))
        assertEquals(manifestB, SessionManifestStore.get(sessionIdB))

        assertEquals("alpha-doc.pdf", SessionManifestStore.getManifest(sessionIdA)!!.fileName)
        assertEquals("beta-data.bin", SessionManifestStore.getManifest(sessionIdB)!!.fileName)

        // Removing session A leaves session B intact
        assertTrue(SessionManifestStore.remove(sessionIdA))
        assertFalse(SessionManifestStore.contains(sessionIdA))
        assertTrue(SessionManifestStore.contains(sessionIdB))
        assertEquals(1, SessionManifestStore.count())
    }

    @Test
    fun testUnknownSessionFailsClosed() {
        val unknownId = ByteArray(16) { 0xFF.toByte() }
        assertFalse(SessionManifestStore.contains(unknownId))
        assertNull(SessionManifestStore.get(unknownId))
        assertNull(SessionManifestStore.getManifest(unknownId))
    }

    @Test
    fun testInvalidSessionIdLengthRejected() {
        assertThrows(IllegalArgumentException::class.java) {
            SessionManifestStore.register(manifestA.copy(sessionId = ByteArray(15)))
        }
    }
}

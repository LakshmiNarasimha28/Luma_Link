package com.lumalink.harness.transfer

import com.lumalink.harness.crypto.TestFixtureSessions
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * Unit tests verifying PreProvisionedManifestStore:
 * - Manifest session ID must match registration session ID
 * - Registration with matching session ID succeeds
 * - Registration with mismatched session ID fails
 * - 16-byte session ID validation
 * - Fail-closed lookup semantics for unknown sessions
 */
class PreProvisionedManifestStoreTest {

    private val validSessionId = TestFixtureSessions.GOLDEN_SESSION_ID_BYTES

    @Before
    fun setUp() {
        PreProvisionedManifestStore.clear()
    }

    @After
    fun tearDown() {
        PreProvisionedManifestStore.clear()
    }

    @Test
    fun testRegistrationWithMatchingSessionIdSucceeds() {
        val manifest = TestFixtureSessions.GOLDEN_MANIFEST_1024B
        PreProvisionedManifestStore.register(validSessionId, manifest)

        val retrieved = PreProvisionedManifestStore.get(validSessionId)
        assertNotNull("Retrieved manifest must not be null", retrieved)
        assertEquals(manifest, retrieved)
        assertEquals(1, PreProvisionedManifestStore.count())
    }

    @Test
    fun testRegistrationWithMismatchedSessionIdFails() {
        val differentSessionId = ByteArray(16) { 0x42.toByte() }
        val manifest = TestFixtureSessions.GOLDEN_MANIFEST_1024B // manifest.sessionId is GOLDEN_SESSION_ID_BYTES

        try {
            PreProvisionedManifestStore.register(differentSessionId, manifest)
            fail("Expected IllegalArgumentException when registration sessionId does not match manifest.sessionId")
        } catch (e: IllegalArgumentException) {
            assertEquals("Manifest session ID does not match registration session ID", e.message)
        }

        assertNull("Mismatched manifest must not be registered", PreProvisionedManifestStore.get(differentSessionId))
        assertEquals(0, PreProvisionedManifestStore.count())
    }

    @Test
    fun testRegistrationWithInvalidSessionIdLengthFails() {
        val shortSessionId = ByteArray(15) { 0x01.toByte() }
        val manifest = TestFixtureSessions.GOLDEN_MANIFEST_1024B

        try {
            PreProvisionedManifestStore.register(shortSessionId, manifest)
            fail("Expected IllegalArgumentException for non-16-byte session ID")
        } catch (e: IllegalArgumentException) {
            assertEquals("Session ID must be 16 bytes", e.message)
        }
    }

    @Test
    fun testUnknownSessionFailsClosed() {
        val unknownSessionId = ByteArray(16) { 0x99.toByte() }
        val result = PreProvisionedManifestStore.get(unknownSessionId)
        assertNull("Lookup for unregistered session must return null (fail-closed)", result)
    }

    @Test
    fun testRemoveAndClear() {
        val manifest = TestFixtureSessions.GOLDEN_MANIFEST_1024B
        PreProvisionedManifestStore.register(validSessionId, manifest)
        assertEquals(1, PreProvisionedManifestStore.count())

        PreProvisionedManifestStore.remove(validSessionId)
        assertNull(PreProvisionedManifestStore.get(validSessionId))
        assertEquals(0, PreProvisionedManifestStore.count())
    }
}

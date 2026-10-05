package com.lumalink.harness.transfer

import java.util.concurrent.ConcurrentHashMap

/**
 * Registry for file manifests in pre-provisioned or negotiated test sessions.
 *
 * Manifest lookup is strictly session-bound using the 16-byte authenticated session ID.
 * Unknown or missing session manifests fail closed (returns null).
 */
object PreProvisionedManifestStore {

    private val manifests = ConcurrentHashMap<String, LumaFileManifest>()

    private fun bytesToHex(bytes: ByteArray): String {
        val sb = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xFF
            if (v < 16) sb.append('0')
            sb.append(Integer.toHexString(v))
        }
        return sb.toString()
    }

    /**
     * Registers a file manifest for the given 16-byte session ID.
     */
    fun register(sessionId: ByteArray, manifest: LumaFileManifest) {
        require(sessionId.size == 16) { "Session ID must be 16 bytes" }
        require(sessionId.contentEquals(manifest.sessionId)) {
            "Manifest session ID does not match registration session ID"
        }
        manifests[bytesToHex(sessionId)] = manifest
    }

    /**
     * Retrieves the file manifest bound to the 16-byte session ID.
     * Returns null if session manifest is unknown (fails closed).
     */
    fun get(sessionId: ByteArray): LumaFileManifest? {
        if (sessionId.size != 16) return null
        return manifests[bytesToHex(sessionId)]
    }

    /**
     * Removes a registered file manifest.
     */
    fun remove(sessionId: ByteArray) {
        if (sessionId.size == 16) {
            manifests.remove(bytesToHex(sessionId))
        }
    }

    /**
     * Clears all registered manifests.
     */
    fun clear() {
        manifests.clear()
    }

    /**
     * Returns the count of registered manifests.
     */
    fun count(): Int = manifests.size
}

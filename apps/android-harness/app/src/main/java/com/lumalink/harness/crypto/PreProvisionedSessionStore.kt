package com.lumalink.harness.crypto

import java.util.concurrent.ConcurrentHashMap

/**
 * Registry for active security contexts in pre-provisioned or negotiated sessions.
 *
 * Contains ZERO hardcoded cryptographic secrets. Session keys must be explicitly
 * registered from external sources or test fixtures.
 */
object PreProvisionedSessionStore {

    private val sessions = ConcurrentHashMap<String, LumaSecurityContext>()

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
     * Registers a security context for the given 16-byte session ID.
     */
    fun register(sessionId: ByteArray, context: LumaSecurityContext) {
        require(sessionId.size == 16) { "Session ID must be 16 bytes" }
        sessions[bytesToHex(sessionId)] = context
    }

    /**
     * Looks up an active security context by 16-byte session ID.
     * Returns null if session is unknown.
     */
    fun get(sessionId: ByteArray): LumaSecurityContext? {
        if (sessionId.size != 16) return null
        return sessions[bytesToHex(sessionId)]
    }

    /**
     * Removes a registered session context.
     */
    fun remove(sessionId: ByteArray) {
        if (sessionId.size == 16) {
            sessions.remove(bytesToHex(sessionId))
        }
    }

    /**
     * Clears all registered sessions.
     */
    fun clear() {
        sessions.clear()
    }

    /**
     * Returns the count of registered active sessions.
     */
    fun count(): Int = sessions.size
}

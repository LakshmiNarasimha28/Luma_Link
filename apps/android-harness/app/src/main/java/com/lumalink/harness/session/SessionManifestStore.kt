package com.lumalink.harness.session

import com.lumalink.harness.transfer.LumaFileManifest
import java.util.concurrent.ConcurrentHashMap

// ============================================================================
// Manifest Registration Result & Conflict Exception
// ============================================================================

sealed class ManifestRegistrationResult {
    /** New session manifest registered for the first time. */
    data object Accepted : ManifestRegistrationResult()

    /** Manifest for this session was already registered and is byte-for-byte identical (idempotent). */
    data object DuplicateAccepted : ManifestRegistrationResult()
}

class ConflictingManifestException(message: String) : LumaManifestException(message)

// ============================================================================
// SessionManifestStore
// ============================================================================

/**
 * Thread-safe, session-bound registry for dynamically acquired file manifests.
 *
 * Replaces static pre-provisioned manifest storage with runtime manifest acquisition
 * from MANIFEST packets (packetType = 1).
 *
 * Invariants:
 * 1. Strictly session-bound: Keyed exclusively by the 16-byte [sessionId].
 * 2. Idempotence: Receiving duplicate MANIFEST packets with identical parameters is accepted without corruption.
 * 3. Complete Conflict Detection: If a MANIFEST arrives for an existing session with ANY differing field,
 *    it is rejected with [ConflictingManifestException], and the original manifest is strictly preserved.
 */
object SessionManifestStore {

    private val sessions = ConcurrentHashMap<String, LumaSessionAnnouncement>()

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
     * Registers a dynamically acquired [LumaSessionAnnouncement].
     *
     * @return [ManifestRegistrationResult.Accepted] if this is a novel session,
     *         or [ManifestRegistrationResult.DuplicateAccepted] if an identical manifest is already registered.
     * @throws ConflictingManifestException if the session ID already exists with conflicting fields.
     */
    fun register(announcement: LumaSessionAnnouncement): ManifestRegistrationResult {
        require(announcement.sessionId.size == 16) {
            "Session ID must be 16 bytes, received ${announcement.sessionId.size}"
        }

        val sessionHex = bytesToHex(announcement.sessionId)
        val existing = sessions[sessionHex]

        if (existing == null) {
            val previous = sessions.putIfAbsent(sessionHex, announcement)
            if (previous == null) {
                return ManifestRegistrationResult.Accepted
            }
            // Handled concurrent registration
            return register(announcement)
        }

        // Compare complete canonical manifest
        if (existing == announcement) {
            return ManifestRegistrationResult.DuplicateAccepted
        }

        // Detail the exact conflicting field for diagnostic visibility
        val reason = when {
            existing.mode != announcement.mode ->
                "security mode mismatch (existing: '${existing.mode}', incoming: '${announcement.mode}')"
            existing.fileName != announcement.fileName ->
                "fileName mismatch (existing: '${existing.fileName}', incoming: '${announcement.fileName}')"
            existing.fileSize != announcement.fileSize ->
                "fileSize mismatch (existing: ${existing.fileSize}, incoming: ${announcement.fileSize})"
            !existing.sha256Digest.equals(announcement.sha256Digest, ignoreCase = true) ->
                "sha256Digest mismatch (existing: ${existing.sha256Digest}, incoming: ${announcement.sha256Digest})"
            existing.symbolSize != announcement.symbolSize ->
                "symbolSize mismatch (existing: ${existing.symbolSize}, incoming: ${announcement.symbolSize})"
            existing.symbolsPerBlock != announcement.symbolsPerBlock ->
                "symbolsPerBlock mismatch (existing: ${existing.symbolsPerBlock}, incoming: ${announcement.symbolsPerBlock})"
            existing.totalBlocks != announcement.totalBlocks ->
                "totalBlocks mismatch (existing: ${existing.totalBlocks}, incoming: ${announcement.totalBlocks})"
            !existing.senderPublicKey.contentEquals(announcement.senderPublicKey) ->
                "senderPublicKey mismatch"
            existing.senderDeviceId != announcement.senderDeviceId ->
                "senderDeviceId mismatch (existing: '${existing.senderDeviceId}', incoming: '${announcement.senderDeviceId}')"
            existing.timestamp != announcement.timestamp ->
                "timestamp mismatch (existing: ${existing.timestamp}, incoming: ${announcement.timestamp})"
            else -> "complete manifest mismatch"
        }

        throw ConflictingManifestException("SESSION_CONFLICT for session $sessionHex: $reason")
    }

    /**
     * Looks up an active session announcement by its 16-byte session ID.
     * Returns null if session is unknown (fails closed).
     */
    fun get(sessionId: ByteArray): LumaSessionAnnouncement? {
        if (sessionId.size != 16) return null
        return sessions[bytesToHex(sessionId)]
    }

    /**
     * Retrieves the file manifest bound to the 16-byte session ID.
     * Returns null if session is unknown (fails closed).
     */
    fun getManifest(sessionId: ByteArray): LumaFileManifest? {
        return get(sessionId)?.toFileManifest()
    }

    /**
     * Checks if a manifest has been registered for the given 16-byte session ID.
     */
    fun contains(sessionId: ByteArray): Boolean {
        if (sessionId.size != 16) return false
        return sessions.containsKey(bytesToHex(sessionId))
    }

    /**
     * Removes a registered session manifest.
     */
    fun remove(sessionId: ByteArray): Boolean {
        if (sessionId.size != 16) return false
        return sessions.remove(bytesToHex(sessionId)) != null
    }

    /**
     * Clears all registered session manifests.
     */
    fun clear() {
        sessions.clear()
    }

    /**
     * Returns the count of registered manifests.
     */
    fun count(): Int = sessions.size
}

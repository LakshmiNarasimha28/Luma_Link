package com.lumalink.harness.crypto

/**
 * Statistics snapshot of replay protection checks.
 */
data class ReplayStats(
    val totalChecked: Long,
    val uniqueAccepted: Long,
    val replaysDetected: Long
)

/**
 * Replay protection filter guarding against duplicate packet injection and replay attacks.
 * Tracks observed sequences separated by direction and packet domain:
 *   "${direction}:${packetTypeCode}:${blockIndex}:${symbolId}"
 *
 * Ensures:
 * - DATA(0, 0) does not block CONTROL(0, 0)
 * - Sender and receiver message spaces do not collide
 * - Replays within the same domain are strictly rejected
 * - Out-of-order fountain symbols are accepted without disruption
 *
 * Faithful mirror of canonical TypeScript ReplayProtector semantics without Android-specific
 * LRU or custom eviction modifications.
 */
class LumaReplayProtector {

    private val seenKeys: MutableSet<String> = HashSet()
    private var totalCheckedCount: Long = 0L
    private var replaysDetectedCount: Long = 0L

    val stats: ReplayStats
        @Synchronized get() = ReplayStats(
            totalChecked = totalCheckedCount,
            uniqueAccepted = seenKeys.size.toLong(),
            replaysDetected = replaysDetectedCount
        )

    /**
     * Checks whether a message sequence is novel within its domain and records it.
     *
     * @param blockIndex Source block index
     * @param symbolId Symbol identifier or sequence counter
     * @param throwOnReplay If true, throws ReplayException instead of returning false
     * @param packetTypeCode Packet domain (2 = DATA, 4 = CONTROL, etc.)
     * @param direction Message flow direction ("sender" or "receiver")
     * @return true if valid and novel; false if already seen (replayed)
     */
    @Synchronized
    fun checkAndRecord(
        blockIndex: Long,
        symbolId: Long,
        throwOnReplay: Boolean = false,
        packetTypeCode: Int = 2,
        direction: String = "sender"
    ): Boolean {
        totalCheckedCount++
        val key = "$direction:$packetTypeCode:$blockIndex:$symbolId"

        if (seenKeys.contains(key)) {
            replaysDetectedCount++
            if (throwOnReplay) {
                throw ReplayException(symbolId)
            }
            return false
        }

        seenKeys.add(key)
        return true
    }

    fun checkAndRecord(
        blockIndex: Int,
        symbolId: Int,
        throwOnReplay: Boolean = false,
        packetTypeCode: Int = 2,
        direction: String = "sender"
    ): Boolean = checkAndRecord(blockIndex.toLong(), symbolId.toLong(), throwOnReplay, packetTypeCode, direction)

    @Synchronized
    fun isSeen(
        blockIndex: Long,
        symbolId: Long,
        packetTypeCode: Int = 2,
        direction: String = "sender"
    ): Boolean {
        val key = "$direction:$packetTypeCode:$blockIndex:$symbolId"
        return seenKeys.contains(key)
    }

    fun isSeen(
        blockIndex: Int,
        symbolId: Int,
        packetTypeCode: Int = 2,
        direction: String = "sender"
    ): Boolean = isSeen(blockIndex.toLong(), symbolId.toLong(), packetTypeCode, direction)

    @Synchronized
    fun reset() {
        seenKeys.clear()
        totalCheckedCount = 0L
        replaysDetectedCount = 0L
    }
}

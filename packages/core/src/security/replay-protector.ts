import { ReplayError, type MessageDirection } from './types.js';

export interface ReplayStats {
  readonly totalChecked: number;
  readonly uniqueAccepted: number;
  readonly replaysDetected: number;
}

/**
 * Replay protection filter guarding against duplicate packet injection and replay attacks.
 * Tracks observed sequences separated by direction and packet domain:
 * `${direction}:${packetTypeCode}:${blockIndex}:${symbolId}`
 *
 * Ensures:
 * - DATA(0, 0) does not block CONTROL(0, 0)
 * - Sender and receiver message spaces do not collide
 * - Replays within the same domain are strictly rejected
 * - Out-of-order fountain symbols are accepted without disruption
 */
export class ReplayProtector {
  private readonly seenKeys: Set<string> = new Set();
  private totalCheckedCount: number = 0;
  private replaysDetectedCount: number = 0;
  private readonly maxTracked: number;

  constructor(maxTracked: number = 65536) {
    this.maxTracked = maxTracked;
  }

  get stats(): ReplayStats {
    return {
      totalChecked: this.totalCheckedCount,
      uniqueAccepted: this.seenKeys.size,
      replaysDetected: this.replaysDetectedCount,
    };
  }

  /**
   * Checks whether a message sequence is novel within its domain and records it.
   *
   * @param blockIndex Source block index
   * @param symbolId Symbol identifier or sequence counter
   * @param throwOnReplay If true, throws ReplayError instead of returning false
   * @param packetTypeCode Packet domain (2 = DATA, 4 = CONTROL, etc.)
   * @param direction Message flow direction ('sender' or 'receiver')
   * @returns true if valid and novel; false if already seen (replayed)
   */
  checkAndRecord(
    blockIndex: number,
    symbolId: number,
    throwOnReplay: boolean = false,
    packetTypeCode: number = 2,
    direction: MessageDirection = 'sender',
  ): boolean {
    this.totalCheckedCount++;
    const key = `${direction}:${packetTypeCode}:${blockIndex}:${symbolId}`;

    if (this.seenKeys.has(key)) {
      this.replaysDetectedCount++;
      if (throwOnReplay) {
        throw new ReplayError(symbolId);
      }
      return false;
    }

    // Guard against unbounded memory consumption in extreme sessions
    if (this.seenKeys.size >= this.maxTracked) {
      // Clear oldest 10%
      const iter = this.seenKeys.values();
      for (let i = 0; i < Math.floor(this.maxTracked * 0.1); i++) {
        const item = iter.next().value;
        if (item) this.seenKeys.delete(item);
      }
    }

    this.seenKeys.add(key);
    return true;
  }

  isSeen(
    blockIndex: number,
    symbolId: number,
    packetTypeCode: number = 2,
    direction: MessageDirection = 'sender',
  ): boolean {
    return this.seenKeys.has(`${direction}:${packetTypeCode}:${blockIndex}:${symbolId}`);
  }

  reset(): void {
    this.seenKeys.clear();
    this.totalCheckedCount = 0;
    this.replaysDetectedCount = 0;
  }
}

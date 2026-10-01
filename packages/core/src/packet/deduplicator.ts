import type { TransportPacket } from './types.js';

export interface DeduplicationStats {
  readonly totalInspected: number;
  readonly uniqueCount: number;
  readonly duplicateCount: number;
}

/**
 * Filter that tracks and drops duplicate transport packets.
 * Keys on (sessionId, blockIndex, symbolId) to guarantee each encoded symbol
 * is only dispatched to the FEC decoding engine once.
 */
export class PacketDeduplicator {
  private readonly seenKeys: Set<string> = new Set();
  private totalInspectedCount: number = 0;
  private duplicateDetectedCount: number = 0;

  /**
   * Constructs a canonical unique key for a packet.
   */
  static getKey(sessionId: string, blockIndex: number, symbolId: number): string {
    return `${sessionId}:${blockIndex}:${symbolId}`;
  }

  /**
   * Inspects a packet and registers it if not previously seen.
   *
   * @param packet The incoming transport packet
   * @returns true if the packet is novel and should be processed; false if it is a duplicate
   */
  process(packet: TransportPacket): boolean {
    this.totalInspectedCount++;
    const key = PacketDeduplicator.getKey(packet.sessionId, packet.blockIndex, packet.symbolId);

    if (this.seenKeys.has(key)) {
      this.duplicateDetectedCount++;
      return false;
    }

    this.seenKeys.add(key);
    return true;
  }

  /**
   * Checks whether a packet has been seen without modifying filter state.
   */
  isDuplicate(packet: TransportPacket): boolean {
    const key = PacketDeduplicator.getKey(packet.sessionId, packet.blockIndex, packet.symbolId);
    return this.seenKeys.has(key);
  }

  get stats(): DeduplicationStats {
    return {
      totalInspected: this.totalInspectedCount,
      uniqueCount: this.seenKeys.size,
      duplicateCount: this.duplicateDetectedCount,
    };
  }

  clear(): void {
    this.seenKeys.clear();
    this.totalInspectedCount = 0;
    this.duplicateDetectedCount = 0;
  }
}

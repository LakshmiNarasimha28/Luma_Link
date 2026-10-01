import { describe, it, expect } from 'vitest';
import { PacketDeduplicator } from '../src/packet/deduplicator.js';
import type { TransportPacket } from '../src/packet/types.js';

describe('Packet Deduplicator', () => {
  function makePacket(sessionId: string, blockIndex: number, symbolId: number): TransportPacket {
    return {
      protocolVersion: 1,
      packetType: 'data',
      flags: 0,
      sessionId,
      blockIndex,
      symbolId,
      fecMetadata: { k: 64, degree: 1 },
      payload: new Uint8Array([1, 2, 3]),
    };
  }

  it('allows novel packets and drops exact duplicates', () => {
    const dedup = new PacketDeduplicator();
    const packet = makePacket('session-A', 0, 1);

    expect(dedup.process(packet)).toBe(true);
    expect(dedup.process(packet)).toBe(false); // Duplicate
    expect(dedup.process(packet)).toBe(false); // Duplicate again

    expect(dedup.stats.totalInspected).toBe(3);
    expect(dedup.stats.uniqueCount).toBe(1);
    expect(dedup.stats.duplicateCount).toBe(2);
  });

  it('distinguishes identical symbol IDs across different blocks', () => {
    const dedup = new PacketDeduplicator();
    const p1 = makePacket('session-A', 0, 5);
    const p2 = makePacket('session-A', 1, 5);

    expect(dedup.process(p1)).toBe(true);
    expect(dedup.process(p2)).toBe(true);
    expect(dedup.stats.uniqueCount).toBe(2);
  });

  it('distinguishes identical symbol IDs across different sessions', () => {
    const dedup = new PacketDeduplicator();
    const p1 = makePacket('session-X', 0, 5);
    const p2 = makePacket('session-Y', 0, 5);

    expect(dedup.process(p1)).toBe(true);
    expect(dedup.process(p2)).toBe(true);
    expect(dedup.stats.uniqueCount).toBe(2);
  });

  it('clears state on clear()', () => {
    const dedup = new PacketDeduplicator();
    const p = makePacket('session-A', 0, 1);

    dedup.process(p);
    expect(dedup.isDuplicate(p)).toBe(true);

    dedup.clear();
    expect(dedup.isDuplicate(p)).toBe(false);
    expect(dedup.stats.totalInspected).toBe(0);
  });
});

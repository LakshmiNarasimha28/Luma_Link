import { describe, it, expect } from 'vitest';
import { SimulatedChannel } from '../src/channel/simulated-channel.js';
import type { TransportPacket } from '../src/packet/types.js';

describe('Simulated Transport Channel', () => {
  function makePackets(count: number): TransportPacket[] {
    return Array.from({ length: count }, (_, i) => ({
      protocolVersion: 1,
      packetType: 'data',
      flags: 0,
      sessionId: 'test-session',
      blockIndex: 0,
      symbolId: i,
      fecMetadata: { k: count, degree: 1 },
      payload: new Uint8Array([i]),
    }));
  }

  it('delivers 100% of packets in order under zero loss and zero reorder', () => {
    const channel = new SimulatedChannel({
      lossRate: 0.0,
      duplicationRate: 0.0,
      reorderRate: 0.0,
    });
    const packets = makePackets(50);
    const delivered = channel.transmitBatch(packets);

    expect(delivered.length).toBe(50);
    for (let i = 0; i < 50; i++) {
      expect(delivered[i]!.symbolId).toBe(i);
    }

    expect(channel.stats.packetsSubmitted).toBe(50);
    expect(channel.stats.packetsDelivered).toBe(50);
    expect(channel.stats.packetsLost).toBe(0);
    expect(channel.stats.effectiveDeliveryRatio).toBe(1.0);
  });

  it('drops packets proportionally under configured loss rate', () => {
    const channel = new SimulatedChannel({
      lossRate: 0.3, // 30% loss
      seed: 42,
    });
    const packets = makePackets(100);
    const delivered = channel.transmitBatch(packets);

    expect(delivered.length).toBeLessThan(100);
    expect(channel.stats.packetsLost).toBeGreaterThan(15);
    expect(channel.stats.packetsLost).toBeLessThan(45);
    expect(channel.stats.packetsDelivered + channel.stats.packetsLost).toBe(100);
  });

  it('duplicates packets under configured duplication rate', () => {
    const channel = new SimulatedChannel({
      duplicationRate: 0.25, // 25% duplication
      seed: 888,
    });
    const packets = makePackets(100);
    const delivered = channel.transmitBatch(packets);

    expect(delivered.length).toBeGreaterThan(100);
    expect(channel.stats.packetsDuplicated).toBeGreaterThan(10);
    expect(channel.stats.packetsDelivered).toBe(100 + channel.stats.packetsDuplicated);
  });

  it('reorders packets when reorderRate > 0', () => {
    const channel = new SimulatedChannel({
      reorderRate: 0.5,
      maxReorderDelay: 5,
      seed: 1234,
    });
    const packets = makePackets(50);
    const delivered = channel.transmitBatch(packets);

    // All packets should still be delivered (loss = 0)
    expect(delivered.length).toBe(50);

    // Check that arrival order is not strictly monotonic [0, 1, 2, ... 49]
    let wasReordered = false;
    for (let i = 0; i < 49; i++) {
      if (delivered[i]!.symbolId > delivered[i + 1]!.symbolId) {
        wasReordered = true;
        break;
      }
    }
    expect(wasReordered).toBe(true);
  });

  it('is completely deterministic under identical seeds', () => {
    const config = {
      lossRate: 0.15,
      duplicationRate: 0.1,
      reorderRate: 0.2,
      seed: 777,
    };
    const ch1 = new SimulatedChannel(config);
    const ch2 = new SimulatedChannel(config);

    const packets = makePackets(40);
    const res1 = ch1.transmitBatch(packets);
    const res2 = ch2.transmitBatch(packets);

    expect(res1.length).toBe(res2.length);
    for (let i = 0; i < res1.length; i++) {
      expect(res1[i]!.symbolId).toBe(res2[i]!.symbolId);
    }
  });
});

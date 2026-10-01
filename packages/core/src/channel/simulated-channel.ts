import { Prng } from '../fec/prng.js';
import type { TransportPacket } from '../packet/types.js';

export interface ChannelConfig {
  /** Packet loss probability [0.0, 1.0]. Default: 0.0 */
  readonly lossRate: number;
  /** Packet duplication probability [0.0, 1.0]. Default: 0.0 */
  readonly duplicationRate: number;
  /** Packet reordering probability [0.0, 1.0]. Default: 0.0 */
  readonly reorderRate: number;
  /** Maximum number of packet slots to delay when reordering. Default: 4 */
  readonly maxReorderDelay: number;
  /** Explicit seed for deterministic PRNG */
  readonly seed: number;
}

export const DEFAULT_CHANNEL_CONFIG: ChannelConfig = {
  lossRate: 0.0,
  duplicationRate: 0.0,
  reorderRate: 0.0,
  maxReorderDelay: 4,
  seed: 1337,
};

export interface ChannelStats {
  readonly packetsSubmitted: number;
  readonly packetsDelivered: number;
  readonly packetsLost: number;
  readonly packetsDuplicated: number;
  readonly packetsReordered: number;
  readonly effectiveDeliveryRatio: number;
}

interface DelayedPacket {
  packet: TransportPacket;
  deliverAtStep: number;
}

/**
 * Deterministic transport channel simulator modeling packet loss,
 * duplication, and arrival order reordering.
 */
export class SimulatedChannel {
  readonly config: ChannelConfig;
  private readonly prng: Prng;

  private submittedCount: number = 0;
  private deliveredCount: number = 0;
  private lostCount: number = 0;
  private duplicatedCount: number = 0;
  private reorderedCount: number = 0;
  private step: number = 0;

  private delayedPackets: DelayedPacket[] = [];

  constructor(config: Partial<ChannelConfig> = {}) {
    this.config = {
      lossRate: config.lossRate ?? DEFAULT_CHANNEL_CONFIG.lossRate,
      duplicationRate: config.duplicationRate ?? DEFAULT_CHANNEL_CONFIG.duplicationRate,
      reorderRate: config.reorderRate ?? DEFAULT_CHANNEL_CONFIG.reorderRate,
      maxReorderDelay: config.maxReorderDelay ?? DEFAULT_CHANNEL_CONFIG.maxReorderDelay,
      seed: config.seed ?? DEFAULT_CHANNEL_CONFIG.seed,
    };

    this.prng = new Prng(this.config.seed);
  }

  get stats(): ChannelStats {
    const ratio = this.submittedCount > 0 ? this.deliveredCount / this.submittedCount : 0.0;

    return {
      packetsSubmitted: this.submittedCount,
      packetsDelivered: this.deliveredCount,
      packetsLost: this.lostCount,
      packetsDuplicated: this.duplicatedCount,
      packetsReordered: this.reorderedCount,
      effectiveDeliveryRatio: ratio,
    };
  }

  /**
   * Submits a single packet to the channel, returning array of packets delivered at this step (0, 1, or more).
   */
  transmit(packet: TransportPacket): TransportPacket[] {
    this.submittedCount++;
    this.step++;
    const output: TransportPacket[] = [];

    // Check if any delayed packets are ready for delivery at this step
    const remainingDelayed: DelayedPacket[] = [];
    for (const d of this.delayedPackets) {
      if (d.deliverAtStep <= this.step) {
        output.push(d.packet);
        this.deliveredCount++;
      } else {
        remainingDelayed.push(d);
      }
    }
    this.delayedPackets = remainingDelayed;

    // 1. Loss Simulation
    if (this.prng.nextFloat() < this.config.lossRate) {
      this.lostCount++;
      return output; // Dropped
    }

    // Packets to be scheduled (original + optional duplicate)
    const packetsToDeliver: TransportPacket[] = [packet];

    // 2. Duplication Simulation
    if (this.prng.nextFloat() < this.config.duplicationRate) {
      this.duplicatedCount++;
      packetsToDeliver.push(packet);
    }

    for (const p of packetsToDeliver) {
      // 3. Reordering Simulation
      if (this.config.reorderRate > 0 && this.prng.nextFloat() < this.config.reorderRate) {
        this.reorderedCount++;
        const delay = this.prng.nextInt(1, this.config.maxReorderDelay);
        this.delayedPackets.push({
          packet: p,
          deliverAtStep: this.step + delay,
        });
      } else {
        output.push(p);
        this.deliveredCount++;
      }
    }

    return output;
  }

  /**
   * Flushes all remaining buffered/delayed packets.
   */
  flush(): TransportPacket[] {
    const output: TransportPacket[] = [];
    // Sort by deliverAtStep
    this.delayedPackets.sort((a, b) => a.deliverAtStep - b.deliverAtStep);
    for (const d of this.delayedPackets) {
      output.push(d.packet);
      this.deliveredCount++;
    }
    this.delayedPackets = [];
    return output;
  }

  /**
   * Transmits an entire batch of packets through the channel, returning all delivered packets.
   */
  transmitBatch(packets: readonly TransportPacket[]): TransportPacket[] {
    const result: TransportPacket[] = [];
    for (const p of packets) {
      const delivered = this.transmit(p);
      for (const d of delivered) {
        result.push(d);
      }
    }
    const flushed = this.flush();
    for (const f of flushed) {
      result.push(f);
    }
    return result;
  }
}

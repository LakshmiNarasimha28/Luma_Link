import type { DuplicateClassification } from './types.js';

export interface FrameDeduplicatorOptions {
  /**
   * Maximum interval in milliseconds between consecutive identical frames
   * to consider them a camera-sensor duplicate rather than an intentional sender repetition.
   * Default: 40 ms (corresponding to camera sampling faster than 25 Hz screen refresh).
   */
  readonly cameraDuplicateThresholdMs?: number | undefined;
  /** Maximum number of packet identifiers to track in memory (default: 10,000) */
  readonly maxTrackedPackets?: number | undefined;
}

/**
 * Three-tier deduplicator for physical optical transmissions.
 *
 * Distinguishes:
 * 1. Camera duplicate (physical sampling artifact): Optical sensor sampled display before screen refresh.
 * 2. Visual frame repetition (sender-side redundancy): Sender intentionally re-displayed frame for optical robustness.
 * 3. Transport packet duplicate (protocol identity): Novel visual frame, but underlying transport/FEC symbol already received.
 * 4. Novel (authoritative new transport data): First arrival of visual payload and transport packet.
 *
 * CRITICAL ARCHITECTURAL PRINCIPLE:
 * Optical frame timing classifications (camera duplicate vs frame repetition) are empirical channel
 * observations. Transport packet identity (sessionId:blockIndex:symbolId) remains authoritative.
 */
export class OpticalFrameDeduplicator {
  private readonly cameraDuplicateThresholdMs: number;
  private readonly maxTrackedPackets: number;

  private lastPayloadBytes?: Uint8Array | undefined;
  private lastPayloadTimestampMs = 0;
  private consecutiveDuplicateCount = 0;

  private readonly seenPacketIds = new Set<string>();
  private readonly packetIdFifo: string[] = [];

  constructor(options?: FrameDeduplicatorOptions) {
    this.cameraDuplicateThresholdMs = options?.cameraDuplicateThresholdMs ?? 40;
    this.maxTrackedPackets = options?.maxTrackedPackets ?? 10_000;
  }

  /**
   * Resets deduplication state.
   */
  reset(): void {
    this.lastPayloadBytes = undefined;
    this.lastPayloadTimestampMs = 0;
    this.consecutiveDuplicateCount = 0;
    this.seenPacketIds.clear();
    this.packetIdFifo.length = 0;
  }

  /**
   * Classifies a newly decoded optical frame and its packet payload.
   *
   * @param payload Raw binary payload decoded from the visual symbol.
   * @param packetId Optional identifier for the transport packet (e.g. "sessionId:block:symbol").
   * @param timestampMs Wall-clock acquisition timestamp of the frame in milliseconds.
   */
  classify(
    payload: Uint8Array,
    packetId?: string | undefined,
    timestampMs?: number | undefined,
  ): DuplicateClassification {
    const now = timestampMs ?? Date.now();
    const isConsecutiveIdentical =
      this.lastPayloadBytes !== undefined &&
      this.areByteArraysEqual(payload, this.lastPayloadBytes);

    if (isConsecutiveIdentical && this.lastPayloadTimestampMs > 0) {
      const deltaMs = now - this.lastPayloadTimestampMs;
      this.lastPayloadTimestampMs = now;
      this.consecutiveDuplicateCount++;

      // If arriving faster than the screen presentation refresh threshold,
      // the camera sensor is oversampling the physical display.
      if (deltaMs <= this.cameraDuplicateThresholdMs) {
        return 'camera_duplicate';
      }

      // If arriving after the refresh threshold, the sender is intentionally
      // presenting the same visual frame for redundancy (frame repetition).
      return 'frame_repetition';
    }

    // New visual frame detected (visual transition from previous frame)
    this.lastPayloadBytes = new Uint8Array(payload);
    this.lastPayloadTimestampMs = now;
    this.consecutiveDuplicateCount = 0;

    // Authoritative Transport Packet Identity Check:
    // Check if this transport packet was already delivered in a previous visual burst
    if (packetId !== undefined && packetId.length > 0) {
      if (this.seenPacketIds.has(packetId)) {
        return 'packet_duplicate';
      }

      this.seenPacketIds.add(packetId);
      this.packetIdFifo.push(packetId);
      if (this.packetIdFifo.length > this.maxTrackedPackets) {
        const oldest = this.packetIdFifo.shift();
        if (oldest) {
          this.seenPacketIds.delete(oldest);
        }
      }
    }

    return 'novel';
  }

  /**
   * Constant-time or exact byte comparison to avoid hash collision edge cases.
   */
  private areByteArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  }
}

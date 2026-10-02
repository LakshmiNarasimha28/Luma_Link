import type { EccLevel, VisualCodec, VisualFrame } from '../visual/types.js';
import { QrVisualCodec } from '../visual/qr-codec.js';
import type { TransportPacket } from '../packet/types.js';
import { VisualPacketCodec } from '../visual/packet-adapter.js';
import type { OpticalFrameSink } from './types.js';

export interface SenderHarnessConfig {
  /** Forced QR symbol version (1..40), or undefined for automatic minimal version */
  readonly version?: number | undefined;
  /** Error correction level ('L' | 'M' | 'Q' | 'H', default: 'M') */
  readonly eccLevel?: EccLevel | undefined;
  /** Pixels per QR module in rendered buffer (default: 8 for crisp display) */
  readonly scale?: number | undefined;
  /** Quiet zone border in modules (default: 4) */
  readonly quietZone?: number | undefined;
  /** Display presentation duration per visual frame in milliseconds (default: 66 ms ~= 15 Hz) */
  readonly frameIntervalMs?: number | undefined;
  /** Number of times each visual frame is consecutively repeated (default: 1) */
  readonly repetitionCount?: number | undefined;
  /** Screen brightness level hint (0.0 to 1.0, default: 1.0) */
  readonly brightness?: number | undefined;
}

/**
 * Sender-side physical display measurement harness.
 * Generates controlled QR visual frames and manages timed display presentation.
 */
export class SenderDisplayHarness {
  readonly config: SenderHarnessConfig;
  readonly visualCodec: VisualCodec;
  readonly packetCodec: VisualPacketCodec;

  private isDisplaying = false;

  constructor(config?: SenderHarnessConfig, visualCodec?: VisualCodec) {
    this.config = {
      version: config?.version,
      eccLevel: config?.eccLevel ?? 'M',
      scale: config?.scale ?? 8,
      quietZone: config?.quietZone ?? 4,
      frameIntervalMs: config?.frameIntervalMs ?? 66,
      repetitionCount: config?.repetitionCount ?? 1,
      brightness: config?.brightness ?? 1.0,
    };
    this.visualCodec = visualCodec ?? new QrVisualCodec();
    this.packetCodec = new VisualPacketCodec(this.visualCodec);
  }

  /**
   * Encodes a sequence of TransportPackets into VisualFrames, applying configured scale and ECC.
   */
  encodePackets(packets: TransportPacket[]): VisualFrame[] {
    return packets.map((packet) =>
      this.packetCodec.encodePacket(packet, {
        version: this.config.version,
        eccLevel: this.config.eccLevel,
        scale: this.config.scale,
        quietZone: this.config.quietZone,
      }),
    );
  }

  /**
   * Encodes arbitrary raw binary payloads into VisualFrames.
   */
  encodePayloads(payloads: Uint8Array[]): VisualFrame[] {
    return payloads.map((payload) =>
      this.visualCodec.encode(payload, {
        version: this.config.version,
        eccLevel: this.config.eccLevel,
        scale: this.config.scale,
        quietZone: this.config.quietZone,
      }),
    );
  }

  /**
   * Generates a controlled test sequence of frames from string labels (e.g. ['A', 'B', 'C', 'D']).
   * Useful for controlled repetition and ordering experiments (e.g. A, A, B, B, C, C).
   */
  generateTestSequence(labels: string[], repeatEach?: number): VisualFrame[] {
    const encoder = new TextEncoder();
    const repetition = repeatEach ?? this.config.repetitionCount ?? 1;
    const frames: VisualFrame[] = [];

    for (const label of labels) {
      const payload = encoder.encode(label);
      const frame = this.visualCodec.encode(payload, {
        version: this.config.version,
        eccLevel: this.config.eccLevel,
        scale: this.config.scale,
        quietZone: this.config.quietZone,
      });

      for (let r = 0; r < repetition; r++) {
        frames.push(frame);
      }
    }

    return frames;
  }

  /**
   * Streams a sequence of visual frames to an OpticalFrameSink with precise frame timing.
   */
  async displaySequence(
    frames: VisualFrame[],
    sink: OpticalFrameSink,
    onProgress?: (frameIndex: number, totalFrames: number) => void,
  ): Promise<void> {
    this.isDisplaying = true;
    const intervalMs = this.config.frameIntervalMs ?? 66;

    try {
      for (let i = 0; i < frames.length; i++) {
        if (!this.isDisplaying) {
          break;
        }

        const frame = frames[i]!;
        await sink.displayFrame(frame);
        onProgress?.(i, frames.length);

        if (intervalMs > 0 && i < frames.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
      }
    } finally {
      this.isDisplaying = false;
    }
  }

  /**
   * Aborts active display sequence.
   */
  stopDisplay(): void {
    this.isDisplaying = false;
  }
}

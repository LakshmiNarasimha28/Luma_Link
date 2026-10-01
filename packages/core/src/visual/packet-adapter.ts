import type { TransportPacket, PacketCodec } from '../packet/types.js';
import { BinaryPacketCodec } from '../packet/binary-codec.js';
import type { VisualCodec, VisualCodecOptions, VisualFrame, PixelBuffer } from './types.js';

/**
 * Adapter bridging transport packets with visual codecs.
 * Supports both:
 * - Strategy A: 1 Transport Packet → 1 Visual Frame
 * - Strategy B: N Transport Packets → 1 Visual Frame (bundled)
 */
export class VisualPacketCodec {
  readonly visualCodec: VisualCodec;
  readonly packetCodec: PacketCodec;

  constructor(visualCodec: VisualCodec, packetCodec: PacketCodec = new BinaryPacketCodec()) {
    this.visualCodec = visualCodec;
    this.packetCodec = packetCodec;
  }

  /**
   * Strategy A: Encodes a single TransportPacket into one VisualFrame.
   */
  encodePacket(packet: TransportPacket, options?: VisualCodecOptions): VisualFrame {
    const wireBytes = this.packetCodec.encode(packet);
    return this.visualCodec.encode(wireBytes, options);
  }

  /**
   * Strategy A: Decodes a single VisualFrame back into a TransportPacket.
   */
  decodePacket(frameOrPixels: VisualFrame | PixelBuffer): TransportPacket {
    const wireBytes = this.visualCodec.decode(frameOrPixels);
    return this.packetCodec.decode(wireBytes);
  }

  /**
   * Strategy B: Bundles multiple TransportPackets into a single VisualFrame using length-prefixed binary framing.
   * Layout: [Count: uint16 BE] + foreach: [Length: uint16 BE] [WireBytes: Length]
   */
  encodePackets(packets: TransportPacket[], options?: VisualCodecOptions): VisualFrame {
    if (packets.length === 0) {
      throw new RangeError('Cannot encode empty packet batch');
    }
    const serializedPackets = packets.map((p) => this.packetCodec.encode(p));
    let totalLength = 2; // 2 bytes count
    for (const sp of serializedPackets) {
      totalLength += 2 + sp.length;
    }

    const packedBuffer = new Uint8Array(totalLength);
    const view = new DataView(
      packedBuffer.buffer,
      packedBuffer.byteOffset,
      packedBuffer.byteLength,
    );
    view.setUint16(0, packets.length, false);
    let offset = 2;

    for (const sp of serializedPackets) {
      view.setUint16(offset, sp.length, false);
      offset += 2;
      packedBuffer.set(sp, offset);
      offset += sp.length;
    }

    return this.visualCodec.encode(packedBuffer, options);
  }

  /**
   * Strategy B: Unpacks multiple TransportPackets from a single VisualFrame.
   */
  decodePackets(frameOrPixels: VisualFrame | PixelBuffer): TransportPacket[] {
    const packedBuffer = this.visualCodec.decode(frameOrPixels);
    if (packedBuffer.length < 2) {
      throw new RangeError('Packed buffer too short to read packet count');
    }
    const view = new DataView(
      packedBuffer.buffer,
      packedBuffer.byteOffset,
      packedBuffer.byteLength,
    );
    const count = view.getUint16(0, false);
    let offset = 2;

    const packets: TransportPacket[] = [];
    for (let i = 0; i < count; i++) {
      if (offset + 2 > packedBuffer.length) {
        throw new RangeError(`Truncated packet length header at index ${i}`);
      }
      const len = view.getUint16(offset, false);
      offset += 2;
      if (offset + len > packedBuffer.length) {
        throw new RangeError(`Truncated packet wire data at index ${i}`);
      }
      const wire = packedBuffer.subarray(offset, offset + len);
      offset += len;
      packets.push(this.packetCodec.decode(wire));
    }

    return packets;
  }
}

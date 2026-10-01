import { describe, it, expect } from 'vitest';
import {
  FileBlocker,
  FileReassembler,
  LtEncoder,
  LtDecoder,
  BinaryPacketCodec,
  PacketDeduplicator,
  SimulatedChannel,
  computeSha256,
  IncompleteTransferError,
} from '@lumalink/core';

describe('Phase 1 End-to-End Transfer Pipeline', () => {
  const symbolSize = 64;
  const symbolsPerBlock = 16; // Block size = 1024 bytes
  const codec = new BinaryPacketCodec();

  function generatePayload(size: number, seed: number = 42): Uint8Array {
    const buffer = new Uint8Array(size);
    let s = seed >>> 0;
    for (let i = 0; i < size; i++) {
      s = (s + 0x6d2b79f5) >>> 0;
      buffer[i] = (s ^ (s >>> 15)) & 0xff;
    }
    return buffer;
  }

  interface RunTransferOptions {
    fileSize: number;
    lossRate?: number;
    duplicationRate?: number;
    reorderRate?: number;
    seed?: number;
    overheadRatio?: number;
  }

  function executeTransfer(options: RunTransferOptions) {
    const {
      fileSize,
      lossRate = 0.0,
      duplicationRate = 0.0,
      reorderRate = 0.0,
      seed = 12345,
      overheadRatio = 2.0, // Standard fountain overhead to comfortably overcome channel erasures
    } = options;

    const originalData = generatePayload(fileSize, seed);
    const originalHash = computeSha256(originalData);

    // 1. SENDER: Partition into blocks
    const blocker = new FileBlocker({ symbolSize, symbolsPerBlock });
    const { manifest, blocks } = blocker.partition(
      originalData,
      'testfile.dat',
      'application/octet-stream',
      '00112233-4455-6677-8899-aabbccddeeff',
    );

    // 2. SENDER: Encode symbols and serialize to binary packets
    const encoder = new LtEncoder();
    const binaryPackets: Uint8Array[] = [];

    for (const block of blocks) {
      const symbolsToGenerate = Math.ceil(block.k * overheadRatio);
      for (const encSym of encoder.encodeBlock(block, symbolsToGenerate)) {
        const packet = {
          protocolVersion: 1,
          packetType: 'data' as const,
          flags: 0,
          sessionId: manifest.sessionId,
          blockIndex: block.blockIndex,
          symbolId: encSym.symbolId,
          fecMetadata: { k: block.k, degree: encSym.degree },
          payload: encSym.data,
        };
        binaryPackets.push(codec.encode(packet));
      }
    }

    // 3. CHANNEL: Simulate optical link impairment
    // Wrap binary packets into transport packet objects for channel simulator
    const channel = new SimulatedChannel({
      lossRate,
      duplicationRate,
      reorderRate,
      seed,
    });

    const packetsForChannel = binaryPackets.map((b) => codec.decode(b));
    const deliveredPackets = channel.transmitBatch(packetsForChannel);

    // 4. RECEIVER: Deduplication & Peeling Decoding
    const deduplicator = new PacketDeduplicator();
    const decoder = new LtDecoder();

    for (const rawPacket of deliveredPackets) {
      // Re-serialize and deserialize to test binary roundtrip over the wire
      const wireBytes = codec.encode(rawPacket);
      const packet = codec.decode(wireBytes);

      // Deduplication check
      if (!deduplicator.process(packet)) {
        continue; // Discard duplicate
      }

      // Feed into LT Decoder
      decoder.addSymbol({
        blockIndex: packet.blockIndex,
        symbolId: packet.symbolId,
        k: packet.fecMetadata.k,
        degree: packet.fecMetadata.degree,
        data: packet.payload,
        isSourceSymbol: packet.fecMetadata.degree === 1,
      });
    }

    // 5. RECEIVER: Check completeness and assemble
    const reassembler = new FileReassembler(manifest);
    for (let b = 0; b < manifest.totalBlocks; b++) {
      if (decoder.isBlockComplete(b)) {
        const blockBytes = decoder.decodeBlock(b)!;
        reassembler.addBlock(b, blockBytes);
      }
    }

    return {
      manifest,
      reassembler,
      originalData,
      originalHash,
      channelStats: channel.stats,
      dedupStats: deduplicator.stats,
    };
  }

  it('1. transfers file with 0% loss (ideal channel)', () => {
    const { reassembler, originalData, originalHash } = executeTransfer({
      fileSize: 2048, // 2 full blocks
      lossRate: 0.0,
      overheadRatio: 1.8,
    });

    expect(reassembler.isComplete()).toBe(true);
    const result = reassembler.reassemble();
    expect(result.success).toBe(true);
    expect(result.fileBytes).toEqual(originalData);
    expect(result.sha256Digest).toBe(originalHash);
  });

  it('2. transfers file with 5% packet loss', () => {
    const { reassembler, originalData, originalHash, channelStats } = executeTransfer({
      fileSize: 1500, // Non-aligned, 2 blocks
      lossRate: 0.05,
      overheadRatio: 2.2,
      seed: 101,
    });

    expect(channelStats.packetsLost).toBeGreaterThan(0);
    expect(reassembler.isComplete()).toBe(true);
    const result = reassembler.reassemble();
    expect(result.fileBytes).toEqual(originalData);
    expect(result.sha256Digest).toBe(originalHash);
  });

  it('3. transfers file with 10% packet loss', () => {
    const { reassembler, originalData, originalHash, channelStats } = executeTransfer({
      fileSize: 3000, // 3 blocks
      lossRate: 0.1,
      overheadRatio: 2.4,
      seed: 202,
    });

    expect(channelStats.packetsLost).toBeGreaterThan(0);
    expect(reassembler.isComplete()).toBe(true);
    const result = reassembler.reassemble();
    expect(result.fileBytes).toEqual(originalData);
    expect(result.sha256Digest).toBe(originalHash);
  });

  it('4. transfers file with 20% packet loss', () => {
    const { reassembler, originalData, originalHash, channelStats } = executeTransfer({
      fileSize: 2500, // 3 blocks
      lossRate: 0.2,
      overheadRatio: 2.8,
      seed: 303,
    });

    expect(channelStats.packetsLost).toBeGreaterThan(0);
    expect(reassembler.isComplete()).toBe(true);
    const result = reassembler.reassemble();
    expect(result.fileBytes).toEqual(originalData);
    expect(result.sha256Digest).toBe(originalHash);
  });

  it('5. transfers file with heavy packet reordering (40% reorder)', () => {
    const { reassembler, originalData, originalHash, channelStats } = executeTransfer({
      fileSize: 2000,
      lossRate: 0.0,
      reorderRate: 0.4,
      overheadRatio: 1.8,
      seed: 404,
    });

    expect(channelStats.packetsReordered).toBeGreaterThan(0);
    expect(reassembler.isComplete()).toBe(true);
    const result = reassembler.reassemble();
    expect(result.fileBytes).toEqual(originalData);
    expect(result.sha256Digest).toBe(originalHash);
  });

  it('6. transfers file with heavy packet duplication (30% duplicates)', () => {
    const { reassembler, originalData, originalHash, channelStats, dedupStats } = executeTransfer({
      fileSize: 1800,
      lossRate: 0.0,
      duplicationRate: 0.3,
      overheadRatio: 1.8,
      seed: 505,
    });

    expect(channelStats.packetsDuplicated).toBeGreaterThan(0);
    expect(dedupStats.duplicateCount).toBe(channelStats.packetsDuplicated);
    expect(reassembler.isComplete()).toBe(true);
    const result = reassembler.reassemble();
    expect(result.fileBytes).toEqual(originalData);
    expect(result.sha256Digest).toBe(originalHash);
  });

  it('7. transfers file with combination of loss + reordering + duplication', () => {
    const { reassembler, originalData, originalHash, channelStats } = executeTransfer({
      fileSize: 4000, // 4 blocks
      lossRate: 0.15,
      reorderRate: 0.25,
      duplicationRate: 0.2,
      overheadRatio: 2.8,
      seed: 606,
    });

    expect(channelStats.packetsLost).toBeGreaterThan(0);
    expect(channelStats.packetsReordered).toBeGreaterThan(0);
    expect(channelStats.packetsDuplicated).toBeGreaterThan(0);

    expect(reassembler.isComplete()).toBe(true);
    const result = reassembler.reassemble();
    expect(result.fileBytes).toEqual(originalData);
    expect(result.sha256Digest).toBe(originalHash);
  });

  it('8. safely reports failure when insufficient symbols are delivered', () => {
    // Only generate 0.3x K symbols (impossible to solve full block)
    const { reassembler } = executeTransfer({
      fileSize: 2048,
      overheadRatio: 0.3, // Insufficient symbols!
      seed: 707,
    });

    expect(reassembler.isComplete()).toBe(false);
    expect(reassembler.getMissingBlocks().length).toBeGreaterThan(0);
    expect(() => reassembler.reassemble()).toThrow(IncompleteTransferError);
  });
});

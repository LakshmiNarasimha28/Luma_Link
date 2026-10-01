import { performance } from 'node:perf_hooks';
import {
  FileBlocker,
  FileReassembler,
  LtEncoder,
  LtDecoder,
  BinaryPacketCodec,
  PacketDeduplicator,
  SimulatedChannel,
  computeSha256,
} from '../packages/core/dist/index.js';

interface BenchmarkResult {
  scenarioName: string;
  fileSizeBytes: number;
  sourceSymbolCount: number;
  encodedSymbolCount: number;
  lossRate: number;
  duplicationRate: number;
  blockingDurationMs: number;
  encodingDurationMs: number;
  serializationDurationMs: number;
  channelDurationMs: number;
  decodingDurationMs: number;
  reassemblyDurationMs: number;
  totalDurationMs: number;
  successfulReconstruction: boolean;
  sha256Match: boolean;
  sha256Digest: string;
  simulatedThroughputMBps: number;
}

function runBenchmark(
  scenarioName: string,
  fileSizeBytes: number,
  symbolSize: number = 256,
  symbolsPerBlock: number = 64,
  lossRate: number = 0.05,
  duplicationRate: number = 0.05,
  reorderRate: number = 0.05,
  overheadRatio: number = 2.0,
): BenchmarkResult {
  const totalStartTime = performance.now();

  // 1. Generate synthetic payload
  const rawBytes = new Uint8Array(fileSizeBytes);
  let seed = 0x12345678;
  for (let i = 0; i < fileSizeBytes; i++) {
    seed = (seed + 0x6d2b79f5) >>> 0;
    rawBytes[i] = (seed ^ (seed >>> 15)) & 0xff;
  }
  const originalDigest = computeSha256(rawBytes);

  // 2. Source Blocking
  const t0 = performance.now();
  const blocker = new FileBlocker({ symbolSize, symbolsPerBlock });
  const { manifest, blocks } = blocker.partition(
    rawBytes,
    'benchmark.dat',
    'application/octet-stream',
    'bench-00000000-1111-2222-3333-444455556666',
  );
  const blockingDurationMs = performance.now() - t0;

  let totalSourceSymbols = 0;
  for (const b of blocks) {
    totalSourceSymbols += b.k;
  }

  // 3. LT FEC Encoding
  const t1 = performance.now();
  const encoder = new LtEncoder();
  const rawPackets = [];

  for (const block of blocks) {
    const symbolCount = Math.ceil(block.k * overheadRatio);
    for (const sym of encoder.encodeBlock(block, symbolCount)) {
      rawPackets.push({
        protocolVersion: 1,
        packetType: 'data' as const,
        flags: 0,
        sessionId: manifest.sessionId,
        blockIndex: block.blockIndex,
        symbolId: sym.symbolId,
        fecMetadata: { k: block.k, degree: sym.degree },
        payload: sym.data,
      });
    }
  }
  const encodingDurationMs = performance.now() - t1;
  const encodedSymbolCount = rawPackets.length;

  // 4. Binary Packet Serialization
  const t2 = performance.now();
  const codec = new BinaryPacketCodec();
  const serializedBuffers: Uint8Array[] = new Array(rawPackets.length);
  for (let i = 0; i < rawPackets.length; i++) {
    serializedBuffers[i] = codec.encode(rawPackets[i]!);
  }
  const serializationDurationMs = performance.now() - t2;

  // 5. Simulated Transport Channel
  const t3 = performance.now();
  const channel = new SimulatedChannel({
    lossRate,
    duplicationRate,
    reorderRate,
    seed: 9999,
  });

  const parsedForChannel = serializedBuffers.map((b) => codec.decode(b));
  const deliveredPackets = channel.transmitBatch(parsedForChannel);
  const channelDurationMs = performance.now() - t3;

  // 6. Packet Deduplication & LT Peeling Decoding
  const t4 = performance.now();
  const deduplicator = new PacketDeduplicator();
  const decoder = new LtDecoder();

  for (const pkt of deliveredPackets) {
    if (!deduplicator.process(pkt)) {
      continue;
    }
    decoder.addSymbol({
      blockIndex: pkt.blockIndex,
      symbolId: pkt.symbolId,
      k: pkt.fecMetadata.k,
      degree: pkt.fecMetadata.degree,
      data: pkt.payload,
      isSourceSymbol: pkt.fecMetadata.degree === 1,
    });
  }
  const decodingDurationMs = performance.now() - t4;

  // 7. File Reassembly & SHA-256 Verification
  const t5 = performance.now();
  const reassembler = new FileReassembler(manifest);
  for (let b = 0; b < manifest.totalBlocks; b++) {
    if (decoder.isBlockComplete(b)) {
      reassembler.addBlock(b, decoder.decodeBlock(b)!);
    }
  }

  const isComplete = reassembler.isComplete();
  let sha256Match = false;
  let actualDigest = '';

  if (isComplete) {
    const res = reassembler.reassemble();
    sha256Match = res.sha256Digest === originalDigest;
    actualDigest = res.sha256Digest;
  }
  const reassemblyDurationMs = performance.now() - t5;

  const totalDurationMs = performance.now() - totalStartTime;
  const throughputMBps = fileSizeBytes / (1024 * 1024) / (totalDurationMs / 1000.0);

  return {
    scenarioName,
    fileSizeBytes,
    sourceSymbolCount: totalSourceSymbols,
    encodedSymbolCount,
    lossRate,
    duplicationRate,
    blockingDurationMs,
    encodingDurationMs,
    serializationDurationMs,
    channelDurationMs,
    decodingDurationMs,
    reassemblyDurationMs,
    totalDurationMs,
    successfulReconstruction: isComplete && sha256Match,
    sha256Match,
    sha256Digest: actualDigest,
    simulatedThroughputMBps: throughputMBps,
  };
}

export function runAllBenchmarks() {
  console.log('='.repeat(80));
  console.log('LUMALINK PHASE 1 — PROTOCOL CORE & FEC BENCHMARK');
  console.log('Note: Software pipeline simulation benchmark. NOT optical goodput.');
  console.log('='.repeat(80));

  const scenarios = [
    {
      name: 'Small Payload (16 KB, 5% loss, 5% dup)',
      size: 16 * 1024,
      loss: 0.05,
      dup: 0.05,
      overhead: 2.0,
    },
    {
      name: 'Medium Payload (64 KB, 10% loss, 5% dup)',
      size: 64 * 1024,
      loss: 0.1,
      dup: 0.05,
      overhead: 2.2,
    },
    {
      name: 'Large Multi-Block Payload (256 KB, 15% loss, 10% dup)',
      size: 256 * 1024,
      loss: 0.15,
      dup: 0.1,
      overhead: 2.4,
    },
  ];

  for (const s of scenarios) {
    const res = runBenchmark(s.name, s.size, 256, 64, s.loss, s.dup, 0.05, s.overhead);

    console.log(`\nScenario: ${res.scenarioName}`);
    console.log(`  Payload Size:          ${(res.fileSizeBytes / 1024).toFixed(1)} KB`);
    console.log(`  Source Symbols (K):    ${res.sourceSymbolCount}`);
    console.log(
      `  Encoded Symbols Sent:  ${res.encodedSymbolCount} (ratio: ${(res.encodedSymbolCount / res.sourceSymbolCount).toFixed(2)}x)`,
    );
    console.log(
      `  Channel Conditions:    ${(res.lossRate * 100).toFixed(0)}% loss, ${(res.duplicationRate * 100).toFixed(0)}% dup`,
    );
    console.log(`  Timing Breakdown:`);
    console.log(`    - Source Blocking:   ${res.blockingDurationMs.toFixed(2)} ms`);
    console.log(`    - LT FEC Encoding:   ${res.encodingDurationMs.toFixed(2)} ms`);
    console.log(`    - Serialization:     ${res.serializationDurationMs.toFixed(2)} ms`);
    console.log(`    - Channel Sim:       ${res.channelDurationMs.toFixed(2)} ms`);
    console.log(`    - LT Peeling Decode: ${res.decodingDurationMs.toFixed(2)} ms`);
    console.log(`    - Reassembly & Hash: ${res.reassemblyDurationMs.toFixed(2)} ms`);
    console.log(`  Total Wall-Clock Time: ${res.totalDurationMs.toFixed(2)} ms`);
    console.log(`  Reconstruction:        ${res.successfulReconstruction ? 'SUCCESS' : 'FAILED'}`);
    console.log(`  SHA-256 Verified:      ${res.sha256Match ? 'MATCH' : 'MISMATCH'}`);
    console.log(`  Simulated Throughput:  ${res.simulatedThroughputMBps.toFixed(2)} MB/s`);
  }

  console.log('\n' + '='.repeat(80));
}

runAllBenchmarks();

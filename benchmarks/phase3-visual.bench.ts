import { performance } from 'node:perf_hooks';
import {
  QrVisualCodec,
  VisualPacketCodec,
  applySaltAndPepperNoise,
  applyPartialObstruction,
  applyBoxBlur,
  applyDownscaleUpscale,
  type TransportPacket,
  type EccLevel,
} from '../packages/core/dist/index.js';

console.log('='.repeat(80));
console.log('LUMALINK PHASE 3 — VISUAL CODEC & QR BASELINE BENCHMARK');
console.log('Note: Software codec simulation benchmark. NOT optical goodput or camera throughput.');
console.log('='.repeat(80));

const codec = new QrVisualCodec();
const packetAdapter = new VisualPacketCodec(codec);

function makePayload(size: number, seed: number = 42): Uint8Array {
  const buf = new Uint8Array(size);
  let s = seed >>> 0;
  for (let i = 0; i < size; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    buf[i] = (s ^ (s >>> 15)) & 0xff;
  }
  return buf;
}

// ============================================================================
// 1. QR Capacity & Software Codec Throughput Benchmark
// ============================================================================
console.log('\n--- 1. QR Codec Scaling & Software Throughput (ECC Level M) ---');
console.log(
  'Payload | Version | Modules   | Pixels (4x) | Encode Time | Decode Time | Codec Speed',
);
console.log(
  '--------|---------|-----------|-------------|-------------|-------------|------------',
);

const testSizes = [32, 64, 128, 256, 512, 1024];

for (const size of testSizes) {
  const payload = makePayload(size);

  // Warmup
  codec.decode(codec.encode(payload, { eccLevel: 'M' }));

  // Benchmark iterations
  const iterations = size > 512 ? 20 : 50;
  let totalEncodeMs = 0;
  let totalDecodeMs = 0;
  let lastFrame;

  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    const frame = codec.encode(payload, { eccLevel: 'M', scale: 4 });
    const t1 = performance.now();
    totalEncodeMs += t1 - t0;
    lastFrame = frame;

    const t2 = performance.now();
    codec.decode(frame);
    const t3 = performance.now();
    totalDecodeMs += t3 - t2;
  }

  const avgEncodeMs = totalEncodeMs / iterations;
  const avgDecodeMs = totalDecodeMs / iterations;
  const totalCodecMs = avgEncodeMs + avgDecodeMs;
  const throughputMBps = (size / 1024 / 1024 / (totalCodecMs / 1000)).toFixed(2);

  const meta = lastFrame!.metadata;
  console.log(
    `${size.toString().padEnd(7)} | V${meta.version.toString().padEnd(6)} | ` +
      `${meta.moduleDimensions.width}x${meta.moduleDimensions.height}`.padEnd(9) +
      ` | ${meta.pixelDimensions.width}x${meta.pixelDimensions.height}`.padEnd(11) +
      ` | ${avgEncodeMs.toFixed(2).padStart(8)} ms` +
      ` | ${avgDecodeMs.toFixed(2).padStart(8)} ms` +
      ` | ${throughputMBps.padStart(6)} MB/s`,
  );
}

// ============================================================================
// 2. ECC Level Trade-offs (256-byte payload)
// ============================================================================
console.log('\n--- 2. Error Correction Level Trade-offs (Payload: 256 Bytes) ---');
console.log('ECC Level | Approx ECC | Version | Matrix Size | Encode Time | Decode Time');
console.log('----------|------------|---------|-------------|-------------|------------');

const eccLevels: Array<{ level: EccLevel; pct: string }> = [
  { level: 'L', pct: '~7%' },
  { level: 'M', pct: '~15%' },
  { level: 'Q', pct: '~25%' },
  { level: 'H', pct: '~30%' },
];

const payload256 = makePayload(256);

for (const { level, pct } of eccLevels) {
  let encTotal = 0;
  let decTotal = 0;
  let frame;
  const iters = 30;

  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    frame = codec.encode(payload256, { eccLevel: level, scale: 4 });
    const t1 = performance.now();
    encTotal += t1 - t0;

    const t2 = performance.now();
    codec.decode(frame);
    const t3 = performance.now();
    decTotal += t3 - t2;
  }

  const meta = frame!.metadata;
  console.log(
    `${level.padEnd(9)} | ${pct.padEnd(10)} | V${meta.version.toString().padEnd(6)} | ` +
      `${meta.moduleDimensions.width}x${meta.moduleDimensions.height}`.padEnd(11) +
      ` | ${(encTotal / iters).toFixed(2).padStart(8)} ms` +
      ` | ${(decTotal / iters).toFixed(2).padStart(8)} ms`,
  );
}

// ============================================================================
// 3. Payload Packing Experiment (Strategy A vs Strategy B)
// ============================================================================
console.log('\n--- 3. Payload Packing Experiment: Strategy A vs Strategy B ---');

function createSamplePacket(symbolId: number, payloadSize: number = 64): TransportPacket {
  return {
    protocolVersion: 1,
    packetType: 'data',
    flags: 0x02,
    sessionId: '12345678-1234-1234-1234-123456789abc',
    blockIndex: 0,
    symbolId,
    fecMetadata: { k: 16, degree: 2 },
    payload: makePayload(16 + payloadSize, symbolId), // 16B AEAD tag + ciphertext
  };
}

const totalPackets = 16;
const samplePackets = Array.from({ length: totalPackets }, (_, i) => createSamplePacket(i));

// Strategy A: 1 Packet per Frame
const tA0 = performance.now();
const framesA = samplePackets.map((pkt) => packetAdapter.encodePacket(pkt, { eccLevel: 'M' }));
const tA1 = performance.now();
const decodedPacketsA = framesA.map((f) => packetAdapter.decodePacket(f));
const tA2 = performance.now();

// Strategy B: 2 Packets bundled per Frame (8 frames)
const bundlesOf2: TransportPacket[][] = [];
for (let i = 0; i < totalPackets; i += 2) {
  bundlesOf2.push([samplePackets[i]!, samplePackets[i + 1]!]);
}
const tB0 = performance.now();
const framesB = bundlesOf2.map((batch) => packetAdapter.encodePackets(batch, { eccLevel: 'M' }));
const tB1 = performance.now();
const decodedPacketsB = framesB.flatMap((f) => packetAdapter.decodePackets(f));
const tB2 = performance.now();

// Strategy B4: 4 Packets bundled per Frame (4 frames)
const bundlesOf4: TransportPacket[][] = [];
for (let i = 0; i < totalPackets; i += 4) {
  bundlesOf4.push([
    samplePackets[i]!,
    samplePackets[i + 1]!,
    samplePackets[i + 2]!,
    samplePackets[i + 3]!,
  ]);
}
const tB40 = performance.now();
const framesB4 = bundlesOf4.map((batch) => packetAdapter.encodePackets(batch, { eccLevel: 'M' }));
const tB41 = performance.now();
const decodedPacketsB4 = framesB4.flatMap((f) => packetAdapter.decodePackets(f));
const tB42 = performance.now();

console.log(
  'Strategy                           | Frames | QR Version | Modules | Total Enc | Total Dec | Status',
);
console.log(
  '-----------------------------------|--------|------------|---------|-----------|-----------|-------',
);
console.log(
  `Strategy A (1 Packet / Frame)       | ${framesA.length.toString().padEnd(6)} | V${framesA[0]!.metadata.version.toString().padEnd(9)} | ` +
    `${framesA[0]!.metadata.moduleDimensions.width}x${framesA[0]!.metadata.moduleDimensions.height}`.padEnd(
      7,
    ) +
    ` | ${(tA1 - tA0).toFixed(1).padStart(7)} ms | ${(tA2 - tA1).toFixed(1).padStart(7)} ms | ${decodedPacketsA.length === 16 ? 'VALID' : 'FAIL'}`,
);
console.log(
  `Strategy B (2 Packets / Frame)      | ${framesB.length.toString().padEnd(6)} | V${framesB[0]!.metadata.version.toString().padEnd(9)} | ` +
    `${framesB[0]!.metadata.moduleDimensions.width}x${framesB[0]!.metadata.moduleDimensions.height}`.padEnd(
      7,
    ) +
    ` | ${(tB1 - tB0).toFixed(1).padStart(7)} ms | ${(tB2 - tB1).toFixed(1).padStart(7)} ms | ${decodedPacketsB.length === 16 ? 'VALID' : 'FAIL'}`,
);
console.log(
  `Strategy B4 (4 Packets / Frame)     | ${framesB4.length.toString().padEnd(6)} | V${framesB4[0]!.metadata.version.toString().padEnd(9)} | ` +
    `${framesB4[0]!.metadata.moduleDimensions.width}x${framesB4[0]!.metadata.moduleDimensions.height}`.padEnd(
      7,
    ) +
    ` | ${(tB41 - tB40).toFixed(1).padStart(7)} ms | ${(tB42 - tB41).toFixed(1).padStart(7)} ms | ${decodedPacketsB4.length === 16 ? 'VALID' : 'FAIL'}`,
);

// ============================================================================
// 4. Synthetic Degradation Resilience Benchmark
// ============================================================================
console.log('\n--- 4. Synthetic Degradation Resilience (Controlled Numerical Simulation) ---');
console.log('Corruption Condition           | Level L (~7%) | Level M (~15%) | Level H (~30%)');
console.log('-------------------------------|---------------|----------------|---------------');

const testPayload = makePayload(64);
const fL = codec.encode(testPayload, { eccLevel: 'L', scale: 5 });
const fM = codec.encode(testPayload, { eccLevel: 'M', scale: 5 });
const fH = codec.encode(testPayload, { eccLevel: 'H', scale: 5 });

function testDegradation(
  name: string,
  transform: (f: ReturnType<typeof codec.encode>) => ReturnType<typeof codec.encode>['pixelBuffer'],
) {
  function tryDecode(frame: ReturnType<typeof codec.encode>): string {
    try {
      const corrupted = transform(frame);
      const res = codec.decode(corrupted);
      return res.length === 64 ? 'PASS' : 'CORRUPT';
    } catch {
      return 'FAIL';
    }
  }

  const resL = tryDecode(fL);
  const resM = tryDecode(fM);
  const resH = tryDecode(fH);
  console.log(`${name.padEnd(30)} | ${resL.padEnd(13)} | ${resM.padEnd(14)} | ${resH.padEnd(14)}`);
}

testDegradation('Clean (0% Corruption)', (f) => f.pixelBuffer);
testDegradation('0.5% Salt-and-Pepper Noise', (f) =>
  applySaltAndPepperNoise(f.pixelBuffer, 0.005, 11),
);
testDegradation('1.0% Salt-and-Pepper Noise', (f) =>
  applySaltAndPepperNoise(f.pixelBuffer, 0.01, 22),
);
testDegradation('1.5% Salt-and-Pepper Noise', (f) =>
  applySaltAndPepperNoise(f.pixelBuffer, 0.015, 33),
);
testDegradation('10% Center Obstruction', (f) =>
  applyPartialObstruction(f.pixelBuffer, 0.45, 0.45, 0.1, 0.1),
);
testDegradation('20% Center Obstruction', (f) =>
  applyPartialObstruction(f.pixelBuffer, 0.45, 0.45, 0.2, 0.2),
);
testDegradation('25% Center Obstruction', (f) =>
  applyPartialObstruction(f.pixelBuffer, 0.45, 0.45, 0.25, 0.25),
);
testDegradation('Light Box Blur (Radius 1)', (f) => applyBoxBlur(f.pixelBuffer, 1));
testDegradation('2x Downsample/Upsample', (f) => applyDownscaleUpscale(f.pixelBuffer, 2));

console.log('='.repeat(80));
console.log('PHASE 3 BENCHMARK COMPLETE\n');

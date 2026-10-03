import {
  FileBlocker,
  SenderSession,
  ReceiverSession,
  computeSha256,
  SenderDisplayHarness,
  ReceiverMeasurementHarness,
  PhysicalOpticalChannelSimulator,
  type TransportPacket,
  type EccLevel,
} from '../packages/core/dist/index.js';
import { NodeCryptoProvider } from '../packages/core/dist/platform/node/index.js';

console.log('='.repeat(80));
console.log('LUMALINK PHASE 4 — OPTICAL CHANNEL & PHYSICAL CAPTURE BENCHMARK');
console.log('Evaluates Level 1 (Codec), Level 2 (Optical Channel), and Level 3 (End-to-End)');
console.log('='.repeat(80));

const crypto = new NodeCryptoProvider();

function makePayload(size: number, seed: number = 777): Uint8Array {
  const buf = new Uint8Array(size);
  let s = seed >>> 0;
  for (let i = 0; i < size; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    buf[i] = (s ^ (s >>> 15)) & 0xff;
  }
  return buf;
}

// ============================================================================
// Benchmark 1: Three Distinct Performance Layers (L1, L2, L3)
// ============================================================================
console.log(
  '\n--- 1. Three Performance Layers: Codec (L1) vs Optical (L2) vs Verified E2E (L3) ---',
);
console.log(
  'Symbol Size | QR Ver/ECC | Modules | L1 Codec Bps | L2 Optical Bps | L3 E2E Goodput | Duplicates',
);
console.log(
  '------------|------------|---------|--------------|----------------|----------------|-----------',
);

const testPayloadSizes = [64, 128, 256, 512];

for (const symbolSize of testPayloadSizes) {
  const ecc: EccLevel = 'M';
  const fileBytes = symbolSize * 16; // 1 block of 16 symbols
  const originalFile = makePayload(fileBytes, 1000 + symbolSize);
  const originalHash = computeSha256(originalFile);

  const blocker = new FileBlocker({ symbolSize, symbolsPerBlock: 16 });
  const { manifest, blocks } = blocker.partition(originalFile, `bench-${symbolSize}.bin`);

  const senderId = { deviceId: 'sender-node', keyPair: crypto.generateKeyPair() };
  const senderSession = new SenderSession(manifest, blocks, 'quick', senderId, crypto);
  const receiverSession = ReceiverSession.createQuickSend(
    senderSession.getAnnouncement(),
    undefined,
    crypto,
  );
  receiverSession.applyKeyEnvelope(
    senderSession.handleAuthRequest(receiverSession.createAuthRequest()).keyEnvelope!,
  );

  const allPackets: TransportPacket[] = [];
  const overhead = 2.0; // 2x fountain overhead
  for (const block of blocks) {
    const kCount = Math.ceil(block.k * overhead);
    for (let s = 0; s < kCount; s++) {
      allPackets.push(senderSession.generateEncryptedPacket(block.blockIndex, s));
    }
  }

  // Sender display harness
  const senderHarness = new SenderDisplayHarness({
    scale: 4,
    eccLevel: ecc,
    repetitionCount: 1,
  });
  const visualFrames = senderHarness.encodePackets(allPackets);
  const qrVersion = visualFrames[0]?.metadata.version ?? 0;
  const qrModules = visualFrames[0]?.metadata.moduleDimensions.width ?? 0;

  // Optical channel simulator: 20 Hz display refresh, 30 FPS camera capture (1.5x sampling)
  const simulator = new PhysicalOpticalChannelSimulator({
    displayRefreshHz: 20,
    cameraCaptureFps: 30,
    repetitionCount: 1,
    dropRate: 0.05, // 5% realistic optical frame drop
  });

  const captured = simulator.generateFrames(visualFrames, 1000);

  const receiverHarness = new ReceiverMeasurementHarness({ cameraDuplicateThresholdMs: 40 });
  receiverHarness.onPacketReceived((pkt) => {
    receiverSession.processPacket(pkt);
  });

  let completionChannelTimeMs = 1000;
  for (const frame of captured) {
    receiverHarness.processFrame(frame);
    if (receiverSession.isComplete()) {
      completionChannelTimeMs = frame.timestampMs;
      break;
    }
  }

  const reassembly = receiverSession.reassemble();
  if (reassembly.success && reassembly.sha256Digest === originalHash) {
    receiverHarness.recordVerifiedTransfer(originalFile.length, completionChannelTimeMs);
  }

  const snap = receiverHarness.getMetricsSnapshot();
  const l1 = `${snap.level1CodecThroughputBps.toLocaleString()} B/s`;
  const l2 = `${snap.level2OpticalGoodputBps.toLocaleString()} B/s`;
  const l3 = `${snap.level3EndToEndGoodputBps.toLocaleString()} B/s`;
  const dupes = `C:${snap.cameraFrameDuplicates} R:${snap.visualFrameRepetitions} P:${snap.transportPacketDuplicates}`;

  console.log(
    `${symbolSize.toString().padEnd(11)} | ` +
      `v${qrVersion} / ${ecc}`.padEnd(10) +
      ` | ` +
      `${qrModules}x${qrModules}`.padEnd(7) +
      ` | ` +
      l1.padEnd(12) +
      ` | ` +
      l2.padEnd(14) +
      ` | ` +
      l3.padEnd(14) +
      ` | ` +
      dupes,
  );
}

// ============================================================================
// Benchmark 2: Frame Repetition Factor vs Optical Channel Loss
// ============================================================================
console.log('\n--- 2. Repetition Factor (R=1 vs R=2 vs R=3) under Optical Loss ---');
console.log(
  'Drop Rate | Repetition | Sent Frames | Captured | Novel Delivered | Reassembly Success',
);
console.log(
  '----------|------------|-------------|----------|-----------------|-------------------',
);

const dropRates = [0.0, 0.1, 0.25];
const repetitions = [1, 2, 3];

for (const dropRate of dropRates) {
  for (const R of repetitions) {
    const symbolSize = 128;
    const fileBytes = symbolSize * 16;
    const originalFile = makePayload(fileBytes, 2000 + R);
    const originalHash = computeSha256(originalFile);

    const blocker = new FileBlocker({ symbolSize, symbolsPerBlock: 16 });
    const { manifest, blocks } = blocker.partition(originalFile, `rep-${R}.bin`);

    const senderSession = new SenderSession(
      manifest,
      blocks,
      'quick',
      { deviceId: 'rep-sender', keyPair: crypto.generateKeyPair() },
      crypto,
    );
    const receiverSession = ReceiverSession.createQuickSend(
      senderSession.getAnnouncement(),
      undefined,
      crypto,
    );
    receiverSession.applyKeyEnvelope(
      senderSession.handleAuthRequest(receiverSession.createAuthRequest()).keyEnvelope!,
    );

    const allPackets: TransportPacket[] = [];
    const overhead = 1.8;
    for (const b of blocks) {
      const count = Math.ceil(b.k * overhead);
      for (let s = 0; s < count; s++) {
        allPackets.push(senderSession.generateEncryptedPacket(b.blockIndex, s));
      }
    }

    const sender = new SenderDisplayHarness({ scale: 4, eccLevel: 'M', repetitionCount: R });
    const visualFrames = sender.encodePackets(allPackets);

    const sim = new PhysicalOpticalChannelSimulator({
      displayRefreshHz: 20,
      cameraCaptureFps: 30,
      repetitionCount: R,
      dropRate,
      seed: 999,
    });

    const captured = sim.generateFrames(visualFrames, 1000);
    const receiver = new ReceiverMeasurementHarness({ cameraDuplicateThresholdMs: 40 });
    receiver.onPacketReceived((p) => receiverSession.processPacket(p));

    captured.forEach((f) => receiver.processFrame(f));

    let success = false;
    if (receiverSession.isComplete()) {
      const res = receiverSession.reassemble();
      success = res.success && res.sha256Digest === originalHash;
    }

    const snap = receiver.getMetricsSnapshot();
    console.log(
      `${(dropRate * 100).toFixed(0)}%`.padEnd(9) +
        ` | ` +
        `R=${R}`.padEnd(10) +
        ` | ` +
        visualFrames.length.toString().padEnd(11) +
        ` | ` +
        snap.totalFramesReceived.toString().padEnd(8) +
        ` | ` +
        snap.uniquePacketsDelivered.toString().padEnd(15) +
        ` | ` +
        (success ? 'YES (SHA-256 Valid)' : 'NO (Deficit)'),
    );
  }
}

console.log('\n' + '='.repeat(80));
console.log('LUMALINK PHASE 4 BENCHMARK COMPLETE');
console.log('='.repeat(80));

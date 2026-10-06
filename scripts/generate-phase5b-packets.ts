import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FileBlocker,
  SenderSession,
  BinaryPacketCodec,
  computeCrc32,
  PortableHasher,
  ManifestCodec,
  ControlCodec,
  type TransportPacket,
} from '../packages/core/dist/index.js';
import { NodeCryptoProvider } from '../packages/core/dist/platform/node/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface Phase5bGenerationConfig {
  /** Size of each source symbol in bytes (default: 64) */
  readonly symbolSize: number;
  /** Number of source symbols per block K (default: 16) */
  readonly symbolsPerBlock: number;
  /** Fountain transmission overhead factor (default: 2.4) */
  readonly overheadFactor: number;
  /** Deterministic PRNG seed for payload generation */
  readonly seed: number;
  /** Output file path for browser display fixture */
  readonly outputPath: string;
  /** Whether to write the generated fixture to disk */
  readonly writeFixture?: boolean;
}

export const DEFAULT_PHASE5B_CONFIG: Phase5bGenerationConfig = {
  symbolSize: 64,
  symbolsPerBlock: 16,
  overheadFactor: 2.4,
  seed: 0x5b5b5b5b,
  outputPath: path.resolve(__dirname, 'display-harness/real-packets.js'),
};

/**
 * Generates a reproducible, structured binary test file.
 * Contains standard binary header signature and deterministic high-entropy bytes.
 */
export function generateDeterministicBinaryPayload(
  sizeBytes: number,
  seed: number = 0x5b5b5b5b,
): Uint8Array {
  const payload = new Uint8Array(sizeBytes);

  // Standard 8-byte PNG-compatible binary magic signature
  payload.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);

  // High-entropy pseudo-random bytes filling the remainder
  let state = seed >>> 0;
  for (let i = 8; i < sizeBytes; i++) {
    state = (Math.imul(state ^ (state >>> 16), 0x45d9f3b) + 0x12345) >>> 0;
    payload[i] = (state >>> 24) & 0xff;
  }

  return payload;
}

export interface GeneratedPacketData {
  readonly symbolId: number;
  readonly blockIndex: number;
  readonly k: number;
  readonly degree: number;
  readonly wireBytes: Uint8Array;
  readonly wireLength: number;
  readonly crc32Hex: string;
}

export interface GenerationResult {
  readonly manifest: {
    readonly sessionId: string;
    readonly fileName: string;
    readonly fileSize: number;
    readonly fileSha256: string;
    readonly symbolSize: number;
    readonly symbolsPerBlock: number;
    readonly totalBlocks: number;
    readonly overheadFactor: number;
    readonly targetSymbols: number;
  };
  readonly sender: SenderSession;
  readonly manifestPacket: GeneratedPacketData;
  readonly keyEnvelopePacket: GeneratedPacketData;
  readonly packets: GeneratedPacketData[];
  readonly fixtureFilePath: string;
}

/**
 * Executes the canonical Phase 5B sender pipeline and generates validated TransportPacket wire bytes
 * from the deterministic test file fixture using genuine CSPRNG session keys.
 */
export function generatePhase5bPackets(
  customConfig: Partial<Phase5bGenerationConfig> = {},
): GenerationResult {
  const config: Phase5bGenerationConfig = { ...DEFAULT_PHASE5B_CONFIG, ...customConfig };
  const crypto = new NodeCryptoProvider();
  const portableHasher = new PortableHasher();
  const packetCodec = new BinaryPacketCodec();

  // 1. Generate deterministic binary file (1 block = symbolSize * symbolsPerBlock)
  const fileSizeBytes = config.symbolSize * config.symbolsPerBlock;
  const rawFile = generateDeterministicBinaryPayload(fileSizeBytes, config.seed);
  const fileSha256 = portableHasher.hashSha256(rawFile);

  // 2. Partition file using canonical FileBlocker
  const blocker = new FileBlocker({
    symbolSize: config.symbolSize,
    symbolsPerBlock: config.symbolsPerBlock,
    hasher: portableHasher,
  });
  const { manifest, blocks } = blocker.partition(
    rawFile,
    'phase5b-optical-test.bin',
    'application/octet-stream',
  );

  if (blocks.length !== 1) {
    throw new Error(`Expected exactly 1 block for initial Phase 5B test, got ${blocks.length}`);
  }
  const block = blocks[0]!;

  // 3. Initialize canonical SenderSession with X25519 & ChaCha20-Poly1305
  const senderIdentity = {
    deviceId: 'phase5b-optical-sender',
    keyPair: crypto.generateKeyPair(),
  };
  const sender = new SenderSession(manifest, blocks, 'quick', senderIdentity, crypto);

  // 3b. Generate, serialize, and validate canonical Session MANIFEST TransportPacket
  const announcement = sender.getAnnouncement();
  const manifestPayload = ManifestCodec.encode(announcement);
  const manifestPacketObj: TransportPacket = {
    protocolVersion: 1,
    packetType: 'manifest',
    flags: 0,
    sessionId: manifest.sessionId,
    blockIndex: 0,
    symbolId: 0,
    fecMetadata: { k: config.symbolsPerBlock, degree: 0 },
    payload: manifestPayload,
    checksum: 0,
  };
  const manifestWireBytes: Uint8Array = packetCodec.encode(manifestPacketObj);
  const decodedManifest: TransportPacket = packetCodec.decode(manifestWireBytes);
  if (decodedManifest.packetType !== 'manifest') {
    throw new Error(`Manifest packetType mismatch: ${decodedManifest.packetType}`);
  }
  const manifestCrcView = new DataView(
    manifestWireBytes.buffer,
    manifestWireBytes.byteOffset,
    manifestWireBytes.byteLength,
  );
  const manifestWireCrc = manifestCrcView.getUint32(38, false);
  const manifestPacketData: GeneratedPacketData = {
    symbolId: 0,
    blockIndex: 0,
    k: config.symbolsPerBlock,
    degree: 0,
    wireBytes: manifestWireBytes,
    wireLength: manifestWireBytes.length,
    crc32Hex: `0x${manifestWireCrc.toString(16).padStart(8, '0')}`,
  };

  // 3c. Generate canonical pre-arranged KeyEnvelope CONTROL packet sealed for test receiver Bob
  const bobPublicKey = new Uint8Array([
    0x88, 0x31, 0x86, 0xb8, 0x00, 0xb4, 0x1d, 0x5c, 0xf0, 0x42, 0x96, 0x95, 0xda, 0x9b, 0x3c, 0xc4,
    0xf3, 0x28, 0xeb, 0xcd, 0x18, 0x4a, 0x6e, 0x48, 0x2f, 0xa5, 0x78, 0xc1, 0x03, 0xf0, 0x6c, 0x77,
  ]);
  const bobKeyEnvelope = sender.authManager.createKeyEnvelope('device-bob', bobPublicKey);
  const authResponsePayload = ControlCodec.encodeAuthResponse({
    sessionId: manifest.sessionId,
    receiverDeviceId: 'device-bob',
    state: 'authorized',
    keyEnvelope: bobKeyEnvelope,
  });
  const keyEnvelopePacketObj: TransportPacket = {
    protocolVersion: 1,
    packetType: 'control',
    flags: 0,
    sessionId: manifest.sessionId,
    blockIndex: 0,
    symbolId: 1, // messageId = 1
    fecMetadata: { k: 0, degree: 0 },
    payload: authResponsePayload,
    checksum: 0,
  };
  const keyEnvelopeWireBytes: Uint8Array = packetCodec.encode(keyEnvelopePacketObj);
  const decodedEnvelopePacket: TransportPacket = packetCodec.decode(keyEnvelopeWireBytes);
  if (decodedEnvelopePacket.packetType !== 'control') {
    throw new Error(`Control packetType mismatch: ${decodedEnvelopePacket.packetType}`);
  }
  const keyEnvelopeCrcView = new DataView(
    keyEnvelopeWireBytes.buffer,
    keyEnvelopeWireBytes.byteOffset,
    keyEnvelopeWireBytes.byteLength,
  );
  const keyEnvelopeWireCrc = keyEnvelopeCrcView.getUint32(38, false);
  const keyEnvelopePacketData: GeneratedPacketData = {
    symbolId: 1,
    blockIndex: 0,
    k: 0,
    degree: 0,
    wireBytes: keyEnvelopeWireBytes,
    wireLength: keyEnvelopeWireBytes.length,
    crc32Hex: `0x${keyEnvelopeWireCrc.toString(16).padStart(8, '0')}`,
  };

  // 4. Determine transmitted packet budget from K * overheadFactor
  const targetSymbols = Math.ceil(block.k * config.overheadFactor);
  const generatedPackets: GeneratedPacketData[] = [];

  // 5. Generate, encrypt, serialize, and strictly validate each TransportPacket
  for (let s = 0; s < targetSymbols; s++) {
    const packet: TransportPacket = sender.generateEncryptedPacket(block.blockIndex, s);
    const wireBytes: Uint8Array = packetCodec.encode(packet);

    // Validation 1: Magic bytes 'LUMA' (0x4C, 0x55, 0x4D, 0x41)
    if (
      wireBytes[0] !== 0x4c ||
      wireBytes[1] !== 0x55 ||
      wireBytes[2] !== 0x4d ||
      wireBytes[3] !== 0x41
    ) {
      throw new Error(`Packet ${s} failed LUMA magic check: [${wireBytes.slice(0, 4).join(', ')}]`);
    }

    // Validation 2: Decode round-trip through canonical BinaryPacketCodec
    const decoded: TransportPacket = packetCodec.decode(wireBytes);

    // Validation 3: Header field integrity
    if (decoded.protocolVersion !== 1) {
      throw new Error(`Packet ${s} protocolVersion mismatch: ${decoded.protocolVersion}`);
    }
    if (decoded.packetType !== 'data') {
      throw new Error(`Packet ${s} packetType mismatch: ${decoded.packetType}`);
    }
    if ((decoded.flags & 0x02) === 0) {
      throw new Error(`Packet ${s} FLAG_ENCRYPTED missing in flags: ${decoded.flags}`);
    }
    if (decoded.sessionId !== manifest.sessionId) {
      throw new Error(
        `Packet ${s} sessionId mismatch: ${decoded.sessionId} !== ${manifest.sessionId}`,
      );
    }
    if (decoded.blockIndex !== block.blockIndex) {
      throw new Error(`Packet ${s} blockIndex mismatch: ${decoded.blockIndex}`);
    }
    if (decoded.symbolId !== s) {
      throw new Error(`Packet ${s} symbolId mismatch: ${decoded.symbolId} !== ${s}`);
    }
    if (decoded.fecMetadata.k !== config.symbolsPerBlock) {
      throw new Error(`Packet ${s} K mismatch: ${decoded.fecMetadata.k}`);
    }
    if (decoded.fecMetadata.degree < 1 || decoded.fecMetadata.degree > config.symbolsPerBlock) {
      throw new Error(`Packet ${s} degree out of range: ${decoded.fecMetadata.degree}`);
    }
    if (decoded.payload.length !== packet.payload.length) {
      throw new Error(
        `Packet ${s} payload length mismatch: ${decoded.payload.length} !== ${packet.payload.length}`,
      );
    }

    // Validation 4: CRC-32 validation over header[0..37] + payload
    const expectedCrc = computeCrc32(wireBytes.subarray(0, 38));
    const fullCrc = computeCrc32(wireBytes.subarray(42), expectedCrc ^ 0xffffffff);
    const view = new DataView(wireBytes.buffer, wireBytes.byteOffset, wireBytes.byteLength);
    const wireCrc = view.getUint32(38, false);

    if (fullCrc !== wireCrc || decoded.checksum !== wireCrc) {
      throw new Error(
        `Packet ${s} CRC-32 mismatch: computed 0x${fullCrc.toString(16)} !== wire 0x${wireCrc.toString(16)}`,
      );
    }

    generatedPackets.push({
      symbolId: s,
      blockIndex: block.blockIndex,
      k: decoded.fecMetadata.k,
      degree: decoded.fecMetadata.degree,
      wireBytes,
      wireLength: wireBytes.length,
      crc32Hex: `0x${wireCrc.toString(16).padStart(8, '0')}`,
    });
  }

  // 6. Write browser-compatible fixture (self-contained, file:// compatible)
  function formatUint8ArrayForFixture(bytes: Uint8Array): string {
    const nums = Array.from(bytes);
    const lines: string[] = [];
    for (let i = 0; i < nums.length; i += 22) {
      lines.push('      ' + nums.slice(i, i + 22).join(', '));
    }
    return '    new Uint8Array([\n' + lines.join(',\n') + ',\n    ])';
  }

  const fixtureContent = `// Auto-generated by scripts/generate-phase5b-packets.ts
// DO NOT EDIT MANUALLY.
// Contains validated canonical LumaLink TransportPacket wire bytes for Phase 5B display harness.

(function () {
  'use strict';

  var manifest = {
    sessionId: ${JSON.stringify(manifest.sessionId)},
    fileName: ${JSON.stringify(manifest.fileName)},
    fileSize: ${manifest.fileSize},
    fileSha256: ${JSON.stringify(fileSha256)},
    symbolSize: ${manifest.symbolSize},
    symbolsPerBlock: ${manifest.symbolsPerBlock},
    totalBlocks: ${manifest.totalBlocks},
    overheadFactor: ${config.overheadFactor},
    totalPackets: ${generatedPackets.length},
    generatedAt: ${JSON.stringify(new Date().toISOString())},
  };

  // Canonical Session Announcement MANIFEST packet (${manifestPacketData.wireLength} bytes, CRC ${manifestPacketData.crc32Hex})
  var manifestPacket =
${formatUint8ArrayForFixture(manifestPacketData.wireBytes)};

  // Canonical Pre-Arranged KeyEnvelope CONTROL packet (${keyEnvelopePacketData.wireLength} bytes, CRC ${keyEnvelopePacketData.crc32Hex})
  var keyEnvelopePacket =
${formatUint8ArrayForFixture(keyEnvelopePacketData.wireBytes)};

  var packets = [
${generatedPackets
  .map(
    (p) =>
      `    // Symbol ${p.symbolId} (Block ${p.blockIndex}, deg ${p.degree}, ${p.wireLength} bytes, CRC ${p.crc32Hex})\n` +
      formatUint8ArrayForFixture(p.wireBytes),
  )
  .join(',\n')},
  ];

  /* global window */
  var root = typeof window !== 'undefined' ? window : globalThis;
  root.LUMALINK_REAL_PACKETS = {
    manifest: manifest,
    manifestPacket: manifestPacket,
    keyEnvelopePacket: keyEnvelopePacket,
    packets: packets,
  };
})();
`;

  const isDirect = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
  const shouldWrite = config.writeFixture ?? (isDirect || customConfig.outputPath !== undefined);
  if (shouldWrite && config.outputPath) {
    fs.mkdirSync(path.dirname(config.outputPath), { recursive: true });
    fs.writeFileSync(config.outputPath, fixtureContent, 'utf8');
  }

  return {
    manifest: {
      sessionId: manifest.sessionId,
      fileName: manifest.fileName,
      fileSize: manifest.fileSize,
      fileSha256,
      symbolSize: config.symbolSize,
      symbolsPerBlock: config.symbolsPerBlock,
      totalBlocks: manifest.totalBlocks,
      overheadFactor: config.overheadFactor,
      targetSymbols,
    },
    sender,
    manifestPacket: manifestPacketData,
    keyEnvelopePacket: keyEnvelopePacketData,
    packets: generatedPackets,
    fixtureFilePath: config.outputPath,
  };
}

// Direct execution entry point
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isDirectRun) {
  console.log('='.repeat(70));
  console.log('LUMALINK PHASE 5B — REAL PROTOCOL PACKET GENERATOR');
  console.log('='.repeat(70));

  try {
    const result = generatePhase5bPackets();
    console.log(`Generated file: ${result.manifest.fileName} (${result.manifest.fileSize} bytes)`);
    console.log(`SHA-256: ${result.manifest.fileSha256}`);
    console.log(`Session ID: ${result.manifest.sessionId}`);
    console.log(
      `Source symbols K: ${result.manifest.symbolsPerBlock}, symbolSize: ${result.manifest.symbolSize} bytes`,
    );
    console.log(
      `Overhead factor: ${result.manifest.overheadFactor}x -> ${result.packets.length} real fountain packets`,
    );
    console.log(`First packet wire size: ${result.packets[0]?.wireLength} bytes`);
    console.log(
      `All ${result.packets.length} packets validated: Magic='LUMA', 42B Header, CRC-32 match.`,
    );
    console.log(`Output fixture written to: ${result.fixtureFilePath}`);
    console.log('='.repeat(70));
  } catch (err) {
    console.error('Generation failed:', err);
    process.exit(1);
  }
}

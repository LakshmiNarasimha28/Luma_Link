import { describe, it, expect } from 'vitest';
import { FileBlocker, computeSha256 } from '../src/transfer/blocker.js';
import {
  FileReassembler,
  Sha256MismatchError,
  IncompleteTransferError,
} from '../src/transfer/reassembler.js';

describe('File Blocking, Reassembly, and SHA-256 Verification', () => {
  const blocker = new FileBlocker({ symbolSize: 16, symbolsPerBlock: 4 }); // 64 bytes per block

  it('handles empty input (0 bytes)', () => {
    const empty = new Uint8Array(0);
    const { manifest, blocks } = blocker.partition(empty, 'empty.bin');

    expect(manifest.fileSize).toBe(0);
    expect(manifest.totalBlocks).toBe(1);
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.data.length).toBe(16 * 1);

    const reassembler = new FileReassembler(manifest);
    reassembler.addBlock(0, blocks[0]!.data);

    const result = reassembler.reassemble();
    expect(result.success).toBe(true);
    expect(result.fileBytes.length).toBe(0);
    expect(result.verifiedSha256).toBe(true);
  });

  it('handles single-byte input', () => {
    const single = new Uint8Array([0x42]);
    const { manifest, blocks } = blocker.partition(single, 'single.bin');

    expect(manifest.fileSize).toBe(1);
    expect(manifest.totalBlocks).toBe(1);
    expect(blocks[0]!.data.length).toBe(64); // 4 * 16

    const reassembler = new FileReassembler(manifest);
    reassembler.addBlock(0, blocks[0]!.data);

    const result = reassembler.reassemble();
    expect(result.success).toBe(true);
    expect(result.fileBytes).toEqual(single);
    expect(result.verifiedSha256).toBe(true);
  });

  it('handles input matching exact block boundary (64 bytes)', () => {
    const exact = new Uint8Array(64);
    for (let i = 0; i < 64; i++) exact[i] = i;

    const { manifest, blocks } = blocker.partition(exact, 'exact.bin');
    expect(manifest.totalBlocks).toBe(1);

    const reassembler = new FileReassembler(manifest);
    reassembler.addBlock(0, blocks[0]!.data);

    const result = reassembler.reassemble();
    expect(result.fileBytes).toEqual(exact);
    expect(result.verifiedSha256).toBe(true);
  });

  it('handles multi-block non-aligned input (150 bytes across 3 blocks)', () => {
    const raw = new Uint8Array(150);
    for (let i = 0; i < 150; i++) raw[i] = (i * 7 + 13) & 0xff;

    const { manifest, blocks } = blocker.partition(raw, 'multi.bin');
    expect(manifest.totalBlocks).toBe(3); // 64 + 64 + 22 -> 3 blocks

    const reassembler = new FileReassembler(manifest);
    for (const b of blocks) {
      reassembler.addBlock(b.blockIndex, b.data);
    }

    const result = reassembler.reassemble();
    expect(result.fileBytes).toEqual(raw);
    expect(result.fileBytes.length).toBe(150);
    expect(result.verifiedSha256).toBe(true);
  });

  it('detects missing blocks and throws IncompleteTransferError', () => {
    const raw = new Uint8Array(150);
    const { manifest, blocks } = blocker.partition(raw, 'multi.bin');

    const reassembler = new FileReassembler(manifest);
    // Add block 0 and block 2, omitting block 1
    reassembler.addBlock(0, blocks[0]!.data);
    reassembler.addBlock(2, blocks[2]!.data);

    expect(reassembler.isComplete()).toBe(false);
    expect(reassembler.getMissingBlocks()).toEqual([1]);
    expect(() => reassembler.reassemble()).toThrow(IncompleteTransferError);
  });

  it('detects corrupted data and throws Sha256MismatchError', () => {
    const raw = new Uint8Array(50);
    const { manifest, blocks } = blocker.partition(raw, 'test.bin');

    const corruptedData = new Uint8Array(blocks[0]!.data);
    corruptedData[0] = 0xff; // Corrupt first byte

    const reassembler = new FileReassembler(manifest);
    reassembler.addBlock(0, corruptedData);

    expect(() => reassembler.reassemble()).toThrow(Sha256MismatchError);
  });

  it('computes consistent SHA-256 digests', () => {
    const data = new TextEncoder().encode('LumaLink Optical Transfer Protocol');
    const hash1 = computeSha256(data);
    const hash2 = computeSha256(data);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });
});

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Core from '@lumalink/core';

describe('Portability & Runtime Independence Verification', () => {
  it('canonical @lumalink/core exports do not include NodeCryptoProvider', () => {
    // NodeCryptoProvider must only be exported from @lumalink/core/node
    expect('NodeCryptoProvider' in Core).toBe(false);
    expect('NodeHasher' in Core).toBe(false);
  });

  it('canonical @lumalink/core exports include Hasher and PortableHasher', () => {
    expect(Core.PortableHasher).toBeDefined();
    expect(Core.defaultHasher).toBeDefined();
    expect(Core.computeSha256).toBeDefined();
  });

  it('FileBlocker and FileReassembler operate cleanly without NodeCryptoProvider', () => {
    // Pure transfer pipeline without AEAD encryption should work purely with PortableHasher
    const blocker = new Core.FileBlocker({
      symbolSize: 64,
      symbolsPerBlock: 16,
    });

    const payload = new Uint8Array(1024);
    for (let i = 0; i < payload.length; i++) {
      payload[i] = (i * 17 + 5) & 0xff;
    }

    const { manifest, blocks } = blocker.partition(payload, 'test.bin', 'application/octet-stream');
    expect(manifest.totalBlocks).toBe(1);
    expect(manifest.sha256Digest).toBe(Core.computeSha256(payload));

    const reassembler = new Core.FileReassembler(manifest);
    expect(reassembler.isComplete()).toBe(false);

    // Reconstruct with block data
    for (const block of blocks) {
      reassembler.addBlock(block.blockIndex, block.data);
    }

    expect(reassembler.isComplete()).toBe(true);
    const result = reassembler.reassemble();
    expect(result.fileBytes).toEqual(payload);
    expect(result.verifiedSha256).toBe(true);
    expect(result.sha256Digest).toBe(manifest.sha256Digest);
  });

  it('verifies that no source files in packages/core/src (outside platform/node) import node:crypto or use Buffer', () => {
    const srcDir = path.resolve(__dirname, '../packages/core/src');
    const nodePlatformDir = path.resolve(srcDir, 'platform/node');

    function scanDir(dir: string): string[] {
      const files: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (fullPath !== nodePlatformDir) {
            files.push(...scanDir(fullPath));
          }
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          files.push(fullPath);
        }
      }
      return files;
    }

    const portableFiles = scanDir(srcDir);
    expect(portableFiles.length).toBeGreaterThan(15);

    const forbiddenPatterns = [
      /from\s+['"]node:crypto['"]/,
      /require\s*\(\s*['"]node:crypto['"]\s*\)/,
      /from\s+['"]crypto['"]/,
      /require\s*\(\s*['"]crypto['"]\s*\)/,
      /\bBuffer\./,
      /\bBuffer\b/,
    ];

    for (const filePath of portableFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');

      for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum];
        if (line === undefined) continue;
        // Ignore comments
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

        for (const pattern of forbiddenPatterns) {
          const match = pattern.test(line);
          if (match) {
            const relPath = path.relative(srcDir, filePath);
            throw new Error(
              `Portability violation: forbidden pattern ${pattern} found in ${relPath}:${lineNum + 1}: "${trimmed}"`,
            );
          }
        }
      }
    }
  });
});

import { describe, it, expect } from 'vitest';
import {
  PortableHasher,
  defaultHasher,
  setDefaultHasher,
  getDefaultHasher,
  computeSha256,
} from '../src/transfer/hasher.js';
import { NodeHasher } from '../src/platform/node/node-hasher.js';

describe('Hasher Abstraction & PortableHasher Verification', () => {
  const portableHasher = new PortableHasher();
  const nodeHasher = new NodeHasher();

  it('matches NIST test vector: empty string', () => {
    const data = new Uint8Array(0);
    const expected = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

    expect(portableHasher.hashSha256(data)).toBe(expected);
    expect(nodeHasher.hashSha256(data)).toBe(expected);
  });

  it('matches NIST test vector: "abc"', () => {
    const data = new TextEncoder().encode('abc');
    const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

    expect(portableHasher.hashSha256(data)).toBe(expected);
    expect(nodeHasher.hashSha256(data)).toBe(expected);
  });

  it('matches NIST test vector: 56-byte multi-block boundary', () => {
    const str = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
    const data = new TextEncoder().encode(str);
    const expected = '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1';

    expect(portableHasher.hashSha256(data)).toBe(expected);
    expect(nodeHasher.hashSha256(data)).toBe(expected);
  });

  it('matches block boundary edge cases (55 bytes, 56 bytes, 64 bytes, 65 bytes, 128 bytes)', () => {
    const testSizes = [55, 56, 64, 65, 119, 120, 128, 129];
    for (const size of testSizes) {
      const data = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        data[i] = (i * 31 + 17) & 0xff;
      }
      const portableResult = portableHasher.hashSha256(data);
      const nodeResult = nodeHasher.hashSha256(data);
      expect(portableResult).toBe(nodeResult);
    }
  });

  it('cross-checks arbitrary binary data against NodeHasher across various sizes', () => {
    const sizes = [1, 2, 7, 16, 63, 64, 65, 100, 512, 1024, 4096, 8192, 16384, 65536];
    for (const size of sizes) {
      const data = new Uint8Array(size);
      let s = (size * 1664525 + 1013904223) >>> 0;
      for (let i = 0; i < size; i++) {
        s = (s * 1664525 + 1013904223) >>> 0;
        data[i] = (s >>> 16) & 0xff;
      }

      const portableHash = portableHasher.hashSha256(data);
      const nodeHash = nodeHasher.hashSha256(data);
      expect(portableHash).toBe(nodeHash);
    }
  });

  it('supports computeSha256 helper and custom hasher injection', () => {
    expect(defaultHasher).toBeDefined();
    const data = new TextEncoder().encode('LumaLink PortableHasher Test');
    const hash1 = computeSha256(data);
    const hash2 = computeSha256(data, portableHasher);
    const hash3 = computeSha256(data, nodeHasher);

    expect(hash1).toBe(hash2);
    expect(hash2).toBe(hash3);
  });

  it('manages default hasher registry correctly', () => {
    const originalDefault = getDefaultHasher();
    try {
      const customHasher = {
        hashSha256: (_d: Uint8Array) => 'custom_mock_hash_value',
      };
      setDefaultHasher(customHasher);
      expect(getDefaultHasher()).toBe(customHasher);

      const dummy = new Uint8Array(4);
      expect(computeSha256(dummy)).toBe('custom_mock_hash_value');
    } finally {
      setDefaultHasher(originalDefault);
    }
  });
});

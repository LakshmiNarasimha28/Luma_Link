import { createHash } from 'node:crypto';
import type { Hasher } from '../../transfer/hasher.js';

/**
 * Node.js-accelerated SHA-256 Hasher using native OpenSSL bindings.
 */
export class NodeHasher implements Hasher {
  hashSha256(data: Uint8Array): string {
    return createHash('sha256').update(data).digest('hex');
  }
}

export const nodeHasher: Hasher = new NodeHasher();

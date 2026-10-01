import { SecurityError, type MessageDirection } from './types.js';

export const NONCE_LENGTH_BYTES = 12;
export const SALT_PREFIX_LENGTH_BYTES = 3;

export interface NonceComponents {
  readonly direction: MessageDirection;
  readonly packetTypeCode: number;
  readonly saltPrefix: Uint8Array;
  readonly blockIndex: number;
  readonly symbolId: number;
}

/**
 * Builds the 1-byte domain tag encoding direction and message/packet type.
 * Bit 7: Direction (0 = sender, 1 = receiver)
 * Bits 6..4: Reserved (0)
 * Bits 3..0: Packet Type Code (1=manifest, 2=data, 3=sync, 4=control)
 */
export function buildDomainTag(direction: MessageDirection, packetTypeCode: number): number {
  const dirBit = direction === 'receiver' ? 0x80 : 0x00;
  return dirBit | (packetTypeCode & 0x0f);
}

/**
 * Parses the 1-byte domain tag into direction and packet type code.
 */
export function parseDomainTag(tag: number): {
  direction: MessageDirection;
  packetTypeCode: number;
} {
  const direction: MessageDirection = (tag & 0x80) !== 0 ? 'receiver' : 'sender';
  const packetTypeCode = tag & 0x0f;
  return { direction, packetTypeCode };
}

/**
 * Manages deterministic 96-bit (12-byte) AEAD nonces for a session.
 *
 * Structure (Big-Endian):
 *   [0]      Domain Tag (1 byte: Bit 7 = direction, Bits 3..0 = packetTypeCode)
 *   [1..3]   Salt prefix (3 bytes, derived from session master secret)
 *   [4..7]   Block Index (uint32 BE)
 *   [8..11]  Symbol ID / Sequence (uint32 BE)
 *
 * Enforces mathematical disjointness across:
 *   - data messages vs control messages
 *   - sender direction vs receiver direction
 *
 * Cryptographic Invariant: An AEAD key must NEVER be reused with the same nonce.
 */
export class NonceManager {
  readonly saltPrefix: Uint8Array;
  private readonly usedNonces: Set<string> = new Set();

  constructor(saltPrefix: Uint8Array) {
    if (saltPrefix.length !== SALT_PREFIX_LENGTH_BYTES) {
      throw new RangeError(
        `Nonce salt prefix must be exactly ${SALT_PREFIX_LENGTH_BYTES} bytes, received ${saltPrefix.length}`,
      );
    }
    this.saltPrefix = new Uint8Array(saltPrefix);
  }

  /**
   * Generates a unique 12-byte nonce for the given domain, direction, block index, and symbol ID.
   * Throws SecurityError if this nonce has already been generated under this session instance.
   */
  generateNonce(
    blockIndex: number,
    symbolId: number,
    packetTypeCode: number = 2,
    direction: MessageDirection = 'sender',
  ): Uint8Array {
    const key = `${direction}:${packetTypeCode}:${blockIndex}:${symbolId}`;
    if (this.usedNonces.has(key)) {
      throw new SecurityError(
        `CRITICAL: Nonce reuse detected for ${direction} domain ${packetTypeCode}, block ${blockIndex}, symbol ${symbolId}. Invariant violated.`,
      );
    }
    this.usedNonces.add(key);

    return NonceManager.buildNonce(
      this.saltPrefix,
      blockIndex,
      symbolId,
      packetTypeCode,
      direction,
    );
  }

  /**
   * Constructs a 12-byte nonce without tracking generation history (used on receiver side).
   */
  static buildNonce(
    saltPrefix: Uint8Array,
    blockIndex: number,
    symbolId: number,
    packetTypeCode: number = 2,
    direction: MessageDirection = 'sender',
  ): Uint8Array {
    if (saltPrefix.length !== SALT_PREFIX_LENGTH_BYTES) {
      throw new RangeError(
        `Salt prefix must be exactly ${SALT_PREFIX_LENGTH_BYTES} bytes, received ${saltPrefix.length}`,
      );
    }
    const nonce = new Uint8Array(NONCE_LENGTH_BYTES);
    nonce[0] = buildDomainTag(direction, packetTypeCode);
    nonce.set(saltPrefix, 1);

    const view = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
    view.setUint32(4, blockIndex, false);
    view.setUint32(8, symbolId, false);

    return nonce;
  }

  /**
   * Parses the components of a 12-byte nonce.
   */
  static parseNonce(nonce: Uint8Array): NonceComponents {
    if (nonce.length !== NONCE_LENGTH_BYTES) {
      throw new RangeError(
        `Invalid nonce length: expected ${NONCE_LENGTH_BYTES} bytes, got ${nonce.length}`,
      );
    }
    const { direction, packetTypeCode } = parseDomainTag(nonce[0]!);
    const saltPrefix = nonce.subarray(1, 4);
    const view = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
    const blockIndex = view.getUint32(4, false);
    const symbolId = view.getUint32(8, false);

    return { direction, packetTypeCode, saltPrefix, blockIndex, symbolId };
  }
}

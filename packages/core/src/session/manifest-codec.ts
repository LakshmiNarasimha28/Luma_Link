import type { SecurityMode } from '../security/types.js';
import type { SessionAnnouncement } from './types.js';
import { sessionIdToBytes, bytesToSessionId } from '../packet/binary-codec.js';

// ============================================================================
// Manifest Codec Errors
// ============================================================================

export class ManifestCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestCodecError';
  }
}

export class TruncatedManifestError extends ManifestCodecError {
  readonly expected: number;
  readonly actual: number;
  constructor(expected: number, actual: number) {
    super(`Truncated manifest: expected at least ${expected} bytes, received ${actual}`);
    this.name = 'TruncatedManifestError';
    this.expected = expected;
    this.actual = actual;
  }
}

export class TrailingDataManifestError extends ManifestCodecError {
  readonly expected: number;
  readonly actual: number;
  constructor(expected: number, actual: number) {
    super(
      `Trailing data detected: manifest length is ${expected} bytes, received buffer of ${actual} bytes`,
    );
    this.name = 'TrailingDataManifestError';
    this.expected = expected;
    this.actual = actual;
  }
}

export class UnsupportedManifestVersionError extends ManifestCodecError {
  readonly version: number;
  constructor(version: number) {
    super(`Unsupported manifest version: ${version} (expected ${ManifestCodec.CURRENT_VERSION})`);
    this.name = 'UnsupportedManifestVersionError';
    this.version = version;
  }
}

export class InvalidManifestFieldError extends ManifestCodecError {
  readonly fieldName: string;
  readonly value: unknown;
  constructor(fieldName: string, value: unknown, reason: string) {
    super(`Invalid manifest field '${fieldName}': ${reason} (value: ${String(value)})`);
    this.name = 'InvalidManifestFieldError';
    this.fieldName = fieldName;
    this.value = value;
  }
}

export class MalformedManifestError extends ManifestCodecError {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedManifestError';
  }
}

// ============================================================================
// Hex Utilities
// ============================================================================

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (clean.length !== 64 || !/^[0-9a-f]{64}$/.test(clean)) {
    throw new InvalidManifestFieldError(
      'sha256Digest',
      hex,
      'Must be a 64-character lowercase hexadecimal string',
    );
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

// ============================================================================
// Manifest Binary Codec
// ============================================================================

/**
 * Deterministic binary serializer and deserializer for SessionAnnouncement.
 *
 * Wire Layout (Big-Endian):
 *   [0]        Manifest Version (uint8 = 1)
 *   [1]        Security Mode (uint8: 1 = 'quick', 2 = 'private')
 *   [2..3]     Reserved (uint16 BE = 0x0000)
 *   [4..19]    Session ID (16 bytes)
 *   [20..27]   Timestamp (uint64 BE, ms since UNIX epoch)
 *   [28..35]   File Size (uint64 BE, bytes)
 *   [36..39]   Total Blocks (uint32 BE)
 *   [40..41]   Symbol Size (uint16 BE)
 *   [42..43]   Symbols Per Block (uint16 BE)
 *   [44..75]   Sender Public Key (32 bytes X25519)
 *   [76..107]  SHA-256 Digest (32 raw bytes)
 *   [108]      Sender Device ID Length N1 (uint8, 0..64)
 *   [109..109+N1-1] Sender Device ID (UTF-8 bytes)
 *   [109+N1..110+N1] File Name Length N2 (uint16 BE, 1..255)
 *   [111+N1..110+N1+N2] File Name (UTF-8 bytes)
 *
 * Total size: 111 + N1 + N2 bytes (Min: 112 bytes, Max: 430 bytes).
 */
export class ManifestCodec {
  static readonly CURRENT_VERSION = 1;
  static readonly FIXED_HEADER_SIZE = 111;
  static readonly MAX_DEVICE_ID_LENGTH = 64;
  static readonly MIN_FILE_NAME_LENGTH = 1;
  static readonly MAX_FILE_NAME_LENGTH = 255;

  private static readonly textEncoder = new TextEncoder();
  private static readonly textDecoder = new TextDecoder('utf-8', { fatal: true });

  /**
   * Serializes a SessionAnnouncement into a deterministic binary buffer.
   */
  static encode(announcement: SessionAnnouncement): Uint8Array {
    // 1. Validate fields
    if (announcement.mode !== 'quick' && announcement.mode !== 'private') {
      throw new InvalidManifestFieldError(
        'mode',
        announcement.mode,
        "Must be 'quick' or 'private'",
      );
    }

    if (announcement.fileSize < 0) {
      throw new InvalidManifestFieldError('fileSize', announcement.fileSize, 'Must be >= 0');
    }

    if (announcement.totalBlocks < 1 || !Number.isInteger(announcement.totalBlocks)) {
      throw new InvalidManifestFieldError('totalBlocks', announcement.totalBlocks, 'Must be >= 1');
    }

    if (announcement.symbolSize < 1 || !Number.isInteger(announcement.symbolSize)) {
      throw new InvalidManifestFieldError('symbolSize', announcement.symbolSize, 'Must be >= 1');
    }

    if (announcement.symbolsPerBlock < 1 || !Number.isInteger(announcement.symbolsPerBlock)) {
      throw new InvalidManifestFieldError(
        'symbolsPerBlock',
        announcement.symbolsPerBlock,
        'Must be >= 1',
      );
    }

    if (announcement.timestamp < 0) {
      throw new InvalidManifestFieldError('timestamp', announcement.timestamp, 'Must be >= 0');
    }

    if (!announcement.senderPublicKey || announcement.senderPublicKey.length !== 32) {
      throw new InvalidManifestFieldError(
        'senderPublicKey',
        announcement.senderPublicKey?.length,
        'Must be exactly 32 bytes',
      );
    }

    const sha256Bytes = hexToBytes(announcement.sha256Digest);
    const sessionBytes = sessionIdToBytes(announcement.sessionId);

    // 2. Encode UTF-8 strings
    const deviceIdBytes = this.textEncoder.encode(announcement.senderDeviceId);
    if (deviceIdBytes.length > this.MAX_DEVICE_ID_LENGTH) {
      throw new InvalidManifestFieldError(
        'senderDeviceId',
        announcement.senderDeviceId,
        `UTF-8 length (${deviceIdBytes.length}) exceeds maximum allowable ${this.MAX_DEVICE_ID_LENGTH} bytes`,
      );
    }

    const fileNameBytes = this.textEncoder.encode(announcement.fileName);
    if (fileNameBytes.length < this.MIN_FILE_NAME_LENGTH) {
      throw new InvalidManifestFieldError(
        'fileName',
        announcement.fileName,
        `UTF-8 length must be at least ${this.MIN_FILE_NAME_LENGTH} byte`,
      );
    }
    if (fileNameBytes.length > this.MAX_FILE_NAME_LENGTH) {
      throw new InvalidManifestFieldError(
        'fileName',
        announcement.fileName,
        `UTF-8 length (${fileNameBytes.length}) exceeds maximum allowable ${this.MAX_FILE_NAME_LENGTH} bytes`,
      );
    }

    // 3. Allocate binary buffer
    const totalLength = this.FIXED_HEADER_SIZE + deviceIdBytes.length + fileNameBytes.length;
    const buffer = new Uint8Array(totalLength);
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    // [0] Manifest Version
    buffer[0] = this.CURRENT_VERSION;

    // [1] Security Mode (1 = quick, 2 = private)
    buffer[1] = announcement.mode === 'quick' ? 1 : 2;

    // [2..3] Reserved (0x0000)
    view.setUint16(2, 0x0000, false);

    // [4..19] Session ID (16 bytes)
    buffer.set(sessionBytes, 4);

    // [20..27] Timestamp (uint64 BE)
    view.setBigUint64(20, BigInt(Math.floor(announcement.timestamp)), false);

    // [28..35] File Size (uint64 BE)
    view.setBigUint64(28, BigInt(Math.floor(announcement.fileSize)), false);

    // [36..39] Total Blocks (uint32 BE)
    view.setUint32(36, announcement.totalBlocks, false);

    // [40..41] Symbol Size (uint16 BE)
    view.setUint16(40, announcement.symbolSize, false);

    // [42..43] Symbols Per Block (uint16 BE)
    view.setUint16(42, announcement.symbolsPerBlock, false);

    // [44..75] Sender Public Key (32 bytes)
    buffer.set(announcement.senderPublicKey, 44);

    // [76..107] SHA-256 Digest (32 bytes)
    buffer.set(sha256Bytes, 76);

    // [108] Sender Device ID Length N1
    buffer[108] = deviceIdBytes.length;

    // [109..109+N1-1] Sender Device ID
    let offset = 109;
    buffer.set(deviceIdBytes, offset);
    offset += deviceIdBytes.length;

    // [offset..offset+1] File Name Length N2 (uint16 BE)
    view.setUint16(offset, fileNameBytes.length, false);
    offset += 2;

    // [offset..offset+N2-1] File Name
    buffer.set(fileNameBytes, offset);

    return buffer;
  }

  /**
   * Deserializes and strictly validates a raw binary buffer into a SessionAnnouncement.
   */
  static decode(raw: Uint8Array): SessionAnnouncement {
    if (raw.length < this.FIXED_HEADER_SIZE + this.MIN_FILE_NAME_LENGTH) {
      throw new TruncatedManifestError(
        this.FIXED_HEADER_SIZE + this.MIN_FILE_NAME_LENGTH,
        raw.length,
      );
    }

    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

    // 1. Verify Manifest Version
    const version = bufferGetUint8(raw, 0);
    if (version !== this.CURRENT_VERSION) {
      throw new UnsupportedManifestVersionError(version);
    }

    // 2. Verify Security Mode
    const modeByte = bufferGetUint8(raw, 1);
    let mode: SecurityMode;
    if (modeByte === 1) {
      mode = 'quick';
    } else if (modeByte === 2) {
      mode = 'private';
    } else {
      throw new InvalidManifestFieldError('mode', modeByte, 'Expected 1 (quick) or 2 (private)');
    }

    // 3. Reserved field check (must be 0x0000)
    const reserved = view.getUint16(2, false);
    if (reserved !== 0x0000) {
      throw new MalformedManifestError(
        `Invalid reserved field: expected 0x0000, received 0x${reserved.toString(16)}`,
      );
    }

    // 4. Session ID
    const sessionBytes = raw.subarray(4, 20);
    const sessionId = bytesToSessionId(sessionBytes);

    // 5. Numeric Fields
    const timestampBig = view.getBigUint64(20, false);
    const timestamp = Number(timestampBig);

    const fileSizeBig = view.getBigUint64(28, false);
    const fileSize = Number(fileSizeBig);

    const totalBlocks = view.getUint32(36, false);
    if (totalBlocks < 1) {
      throw new InvalidManifestFieldError('totalBlocks', totalBlocks, 'Must be >= 1');
    }

    const symbolSize = view.getUint16(40, false);
    if (symbolSize < 1) {
      throw new InvalidManifestFieldError('symbolSize', symbolSize, 'Must be >= 1');
    }

    const symbolsPerBlock = view.getUint16(42, false);
    if (symbolsPerBlock < 1) {
      throw new InvalidManifestFieldError('symbolsPerBlock', symbolsPerBlock, 'Must be >= 1');
    }

    // 6. Cryptographic Material
    const senderPublicKey = new Uint8Array(raw.subarray(44, 76)); // Defensive copy
    const sha256Bytes = raw.subarray(76, 108);
    const sha256Digest = bytesToHex(sha256Bytes);

    // 7. Variable Length Field 1: senderDeviceId
    const deviceIdLength = bufferGetUint8(raw, 108);
    if (deviceIdLength > this.MAX_DEVICE_ID_LENGTH) {
      throw new InvalidManifestFieldError(
        'senderDeviceIdLength',
        deviceIdLength,
        `Exceeds maximum ${this.MAX_DEVICE_ID_LENGTH} bytes`,
      );
    }

    let offset = 109;
    if (raw.length < offset + deviceIdLength + 2) {
      throw new TruncatedManifestError(offset + deviceIdLength + 2, raw.length);
    }

    let senderDeviceId = '';
    if (deviceIdLength > 0) {
      const deviceIdRaw = raw.subarray(offset, offset + deviceIdLength);
      try {
        senderDeviceId = this.textDecoder.decode(deviceIdRaw);
      } catch {
        throw new MalformedManifestError('Invalid UTF-8 sequence in senderDeviceId');
      }
      offset += deviceIdLength;
    }

    // 8. Variable Length Field 2: fileName
    const fileNameLength = view.getUint16(offset, false);
    offset += 2;

    if (fileNameLength < this.MIN_FILE_NAME_LENGTH || fileNameLength > this.MAX_FILE_NAME_LENGTH) {
      throw new InvalidManifestFieldError(
        'fileNameLength',
        fileNameLength,
        `Must be between ${this.MIN_FILE_NAME_LENGTH} and ${this.MAX_FILE_NAME_LENGTH} bytes`,
      );
    }

    const expectedTotalLength = offset + fileNameLength;
    if (raw.length < expectedTotalLength) {
      throw new TruncatedManifestError(expectedTotalLength, raw.length);
    }
    if (raw.length > expectedTotalLength) {
      throw new TrailingDataManifestError(expectedTotalLength, raw.length);
    }

    const fileNameRaw = raw.subarray(offset, offset + fileNameLength);
    let fileName: string;
    try {
      fileName = this.textDecoder.decode(fileNameRaw);
    } catch {
      throw new MalformedManifestError('Invalid UTF-8 sequence in fileName');
    }

    return {
      sessionId,
      mode,
      senderDeviceId,
      senderPublicKey,
      fileName,
      fileSize,
      sha256Digest,
      symbolSize,
      symbolsPerBlock,
      totalBlocks,
      timestamp,
    };
  }
}

function bufferGetUint8(buffer: Uint8Array, index: number): number {
  const val = buffer[index];
  if (val === undefined) {
    throw new TruncatedManifestError(index + 1, buffer.length);
  }
  return val;
}

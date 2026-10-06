import { describe, it, expect } from 'vitest';
import {
  ManifestCodec,
  TruncatedManifestError,
  TrailingDataManifestError,
  UnsupportedManifestVersionError,
  InvalidManifestFieldError,
  MalformedManifestError,
  type SessionAnnouncement,
} from '../src/session/index.js';

describe('ManifestCodec (SessionAnnouncement Binary Codec)', () => {
  // Test fixture matching Android golden test vector
  const GOLDEN_ANNOUNCEMENT: SessionAnnouncement = {
    sessionId: '09e99973-c478-442d-af60-2baf76b1d795',
    mode: 'quick',
    senderDeviceId: 'sender-test-dev-01',
    senderPublicKey: new Uint8Array([
      0x07, 0xa3, 0x7c, 0xbc, 0x14, 0x20, 0x93, 0xc8, 0xb7, 0x55, 0xdc, 0x1b, 0x10, 0xe8, 0x6c,
      0xb4, 0x26, 0x37, 0x4a, 0xd1, 0x6a, 0xa8, 0x53, 0xed, 0x0b, 0xdf, 0xc0, 0xb2, 0xb8, 0x6d,
      0x1c, 0x7c,
    ]),
    fileName: 'test-file.bin',
    fileSize: 1024,
    sha256Digest: '6d08077b4795f29ba27c3f7802ba28d26bf8cc55f8b60e6081bbda4e15c7760f',
    symbolSize: 64,
    symbolsPerBlock: 16,
    totalBlocks: 1,
    timestamp: 1728120000000, // 2024-10-05T09:20:00.000Z
  };

  it('1. encodes and decodes the golden announcement with round-trip fidelity', () => {
    const encoded = ManifestCodec.encode(GOLDEN_ANNOUNCEMENT);
    expect(encoded).toBeInstanceOf(Uint8Array);

    // Fixed header (111) + senderDeviceId length (18) + fileName length (13) = 142 bytes
    expect(encoded.length).toBe(142);

    // Byte layout checks
    expect(encoded[0]).toBe(1); // Version = 1
    expect(encoded[1]).toBe(1); // Mode = 1 (quick)
    expect(encoded[2]).toBe(0); // Reserved MSB
    expect(encoded[3]).toBe(0); // Reserved LSB

    // SessionId: 09e99973-c478-442d-af60-2baf76b1d795
    expect(encoded[4]).toBe(0x09);
    expect(encoded[5]).toBe(0xe9);
    expect(encoded[19]).toBe(0x95);

    // Sender device ID length at byte 108
    expect(encoded[108]).toBe(18);

    // File name length (16-bit BE at 109 + 18 = 127)
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    expect(view.getUint16(127, false)).toBe(13);

    // Decode round-trip
    const decoded = ManifestCodec.decode(encoded);
    expect(decoded.sessionId).toBe(GOLDEN_ANNOUNCEMENT.sessionId);
    expect(decoded.mode).toBe('quick');
    expect(decoded.senderDeviceId).toBe(GOLDEN_ANNOUNCEMENT.senderDeviceId);
    expect(Array.from(decoded.senderPublicKey)).toEqual(
      Array.from(GOLDEN_ANNOUNCEMENT.senderPublicKey),
    );
    expect(decoded.fileName).toBe(GOLDEN_ANNOUNCEMENT.fileName);
    expect(decoded.fileSize).toBe(GOLDEN_ANNOUNCEMENT.fileSize);
    expect(decoded.sha256Digest).toBe(GOLDEN_ANNOUNCEMENT.sha256Digest);
    expect(decoded.symbolSize).toBe(GOLDEN_ANNOUNCEMENT.symbolSize);
    expect(decoded.symbolsPerBlock).toBe(GOLDEN_ANNOUNCEMENT.symbolsPerBlock);
    expect(decoded.totalBlocks).toBe(GOLDEN_ANNOUNCEMENT.totalBlocks);
    expect(decoded.timestamp).toBe(GOLDEN_ANNOUNCEMENT.timestamp);
  });

  it('2. supports private send mode (mode byte = 2)', () => {
    const privateAnnouncement: SessionAnnouncement = {
      ...GOLDEN_ANNOUNCEMENT,
      mode: 'private',
    };
    const encoded = ManifestCodec.encode(privateAnnouncement);
    expect(encoded[1]).toBe(2);

    const decoded = ManifestCodec.decode(encoded);
    expect(decoded.mode).toBe('private');
  });

  it('3. handles empty senderDeviceId and multi-byte UTF-8 file names', () => {
    const utf8Announcement: SessionAnnouncement = {
      ...GOLDEN_ANNOUNCEMENT,
      senderDeviceId: '', // length 0
      fileName: 'föö-bår-🚀.bin',
    };

    const encoded = ManifestCodec.encode(utf8Announcement);
    expect(encoded[108]).toBe(0); // deviceId length = 0

    const decoded = ManifestCodec.decode(encoded);
    expect(decoded.senderDeviceId).toBe('');
    expect(decoded.fileName).toBe('föö-bår-🚀.bin');
  });

  it('4. handles boundary string lengths: 64-byte device ID and 255-byte file name', () => {
    const maxDeviceId = 'd'.repeat(64);
    const maxFileName = 'f'.repeat(255);
    const boundaryAnnouncement: SessionAnnouncement = {
      ...GOLDEN_ANNOUNCEMENT,
      senderDeviceId: maxDeviceId,
      fileName: maxFileName,
    };

    const encoded = ManifestCodec.encode(boundaryAnnouncement);
    // 111 + 64 + 255 = 430 bytes
    expect(encoded.length).toBe(430);

    const decoded = ManifestCodec.decode(encoded);
    expect(decoded.senderDeviceId).toBe(maxDeviceId);
    expect(decoded.fileName).toBe(maxFileName);
  });

  it('5. handles large files > 4GB (64-bit unsigned integers)', () => {
    const largeSize = 10 * 1024 * 1024 * 1024; // 10 GB
    const largeAnnouncement: SessionAnnouncement = {
      ...GOLDEN_ANNOUNCEMENT,
      fileSize: largeSize,
      totalBlocks: 10000,
    };

    const encoded = ManifestCodec.encode(largeAnnouncement);
    const decoded = ManifestCodec.decode(encoded);
    expect(decoded.fileSize).toBe(largeSize);
    expect(decoded.totalBlocks).toBe(10000);
  });

  it('6. rejects truncated buffers with TruncatedManifestError', () => {
    const encoded = ManifestCodec.encode(GOLDEN_ANNOUNCEMENT);

    // Empty buffer
    expect(() => ManifestCodec.decode(new Uint8Array(0))).toThrow(TruncatedManifestError);

    // Truncated fixed header
    expect(() => ManifestCodec.decode(encoded.subarray(0, 50))).toThrow(TruncatedManifestError);
    expect(() => ManifestCodec.decode(encoded.subarray(0, 110))).toThrow(TruncatedManifestError);

    // Truncated at string lengths
    expect(() => ManifestCodec.decode(encoded.subarray(0, 115))).toThrow(TruncatedManifestError);
    expect(() => ManifestCodec.decode(encoded.subarray(0, encoded.length - 1))).toThrow(
      TruncatedManifestError,
    );
  });

  it('7. rejects trailing data with TrailingDataManifestError', () => {
    const encoded = ManifestCodec.encode(GOLDEN_ANNOUNCEMENT);
    const withTrailing = new Uint8Array(encoded.length + 5);
    withTrailing.set(encoded, 0);
    withTrailing.set([0xde, 0xad, 0xbe, 0xef, 0x00], encoded.length);

    expect(() => ManifestCodec.decode(withTrailing)).toThrow(TrailingDataManifestError);
  });

  it('8. rejects unsupported manifest versions with UnsupportedManifestVersionError', () => {
    const encoded = ManifestCodec.encode(GOLDEN_ANNOUNCEMENT);
    encoded[0] = 2; // Version 2
    expect(() => ManifestCodec.decode(encoded)).toThrow(UnsupportedManifestVersionError);

    encoded[0] = 0; // Version 0
    expect(() => ManifestCodec.decode(encoded)).toThrow(UnsupportedManifestVersionError);
  });

  it('9. rejects invalid security mode byte', () => {
    const encoded = ManifestCodec.encode(GOLDEN_ANNOUNCEMENT);
    encoded[1] = 0; // Invalid mode 0
    expect(() => ManifestCodec.decode(encoded)).toThrow(InvalidManifestFieldError);

    encoded[1] = 3; // Invalid mode 3
    expect(() => ManifestCodec.decode(encoded)).toThrow(InvalidManifestFieldError);
  });

  it('10. rejects non-zero reserved bytes', () => {
    const encoded = ManifestCodec.encode(GOLDEN_ANNOUNCEMENT);
    encoded[2] = 0x01; // Reserved field corrupted
    expect(() => ManifestCodec.decode(encoded)).toThrow(MalformedManifestError);
  });

  it('11. rejects invalid input fields during encode', () => {
    // Invalid mode
    expect(() =>
      ManifestCodec.encode({ ...GOLDEN_ANNOUNCEMENT, mode: 'invalid' as unknown as 'quick' }),
    ).toThrow(InvalidManifestFieldError);

    // Negative fileSize
    expect(() => ManifestCodec.encode({ ...GOLDEN_ANNOUNCEMENT, fileSize: -1 })).toThrow(
      InvalidManifestFieldError,
    );

    // Zero totalBlocks
    expect(() => ManifestCodec.encode({ ...GOLDEN_ANNOUNCEMENT, totalBlocks: 0 })).toThrow(
      InvalidManifestFieldError,
    );

    // Zero symbolSize
    expect(() => ManifestCodec.encode({ ...GOLDEN_ANNOUNCEMENT, symbolSize: 0 })).toThrow(
      InvalidManifestFieldError,
    );

    // Zero symbolsPerBlock
    expect(() => ManifestCodec.encode({ ...GOLDEN_ANNOUNCEMENT, symbolsPerBlock: 0 })).toThrow(
      InvalidManifestFieldError,
    );

    // Invalid senderPublicKey length
    expect(() =>
      ManifestCodec.encode({ ...GOLDEN_ANNOUNCEMENT, senderPublicKey: new Uint8Array(16) }),
    ).toThrow(InvalidManifestFieldError);

    // Invalid sha256Digest length
    expect(() => ManifestCodec.encode({ ...GOLDEN_ANNOUNCEMENT, sha256Digest: 'short' })).toThrow(
      InvalidManifestFieldError,
    );

    // Sender device ID > 64 bytes
    expect(() =>
      ManifestCodec.encode({ ...GOLDEN_ANNOUNCEMENT, senderDeviceId: 'x'.repeat(65) }),
    ).toThrow(InvalidManifestFieldError);

    // File name length = 0
    expect(() => ManifestCodec.encode({ ...GOLDEN_ANNOUNCEMENT, fileName: '' })).toThrow(
      InvalidManifestFieldError,
    );

    // File name length > 255 bytes
    expect(() =>
      ManifestCodec.encode({ ...GOLDEN_ANNOUNCEMENT, fileName: 'x'.repeat(256) }),
    ).toThrow(InvalidManifestFieldError);
  });

  it('12. rejects malformed UTF-8 sequences', () => {
    const encoded = ManifestCodec.encode(GOLDEN_ANNOUNCEMENT);

    // Corrupt fileName UTF-8 bytes (offset 129 is start of 'test-file.bin')
    // 0xFF is an invalid UTF-8 byte
    encoded[129] = 0xff;
    expect(() => ManifestCodec.decode(encoded)).toThrow(MalformedManifestError);
  });
});

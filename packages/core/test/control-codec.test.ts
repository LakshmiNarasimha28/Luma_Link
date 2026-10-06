import { describe, it, expect } from 'vitest';
import {
  ControlCodec,
  TruncatedControlMessageError,
  TrailingDataControlMessageError,
  UnsupportedControlVersionError,
  InvalidControlMessageTypeError,
  InvalidControlFieldError,
  MalformedControlMessageError,
  type AuthRequest,
  type AuthResponse,
} from '../src/security/index.js';

describe('ControlCodec (Binary CONTROL Codec)', () => {
  // Test fixture matching Android golden test vector
  const GOLDEN_SESSION_ID = '09e99973-c478-442d-af60-2baf76b1d795';
  const RECEIVER_PUB_KEY = new Uint8Array([
    0x88, 0x31, 0x86, 0xb8, 0x00, 0xb4, 0x1d, 0x5c, 0xf0, 0x42, 0x96, 0x95,
    0xda, 0x9b, 0x3c, 0xc4, 0xf3, 0x28, 0xeb, 0xcd, 0x18, 0x4a, 0x6e, 0x48,
    0x2f, 0xa5, 0x78, 0xc1, 0x03, 0xf0, 0x6c, 0x77,
  ]);
  const SENDER_PUB_KEY = new Uint8Array([
    0x07, 0xa3, 0x7c, 0xbc, 0x14, 0x20, 0x93, 0xc8, 0xb7, 0x55, 0xdc, 0x1b,
    0x10, 0xe8, 0x6c, 0xb4, 0x26, 0x37, 0x4a, 0xd1, 0x6a, 0xa8, 0x53, 0xed,
    0x0b, 0xdf, 0xc0, 0xb2, 0xb8, 0x6d, 0x1c, 0x7c,
  ]);
  const WRAP_NONCE = new Uint8Array([
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
  ]);
  const WRAP_TAG = new Uint8Array([
    0x19, 0x35, 0x48, 0x4b, 0xaf, 0xc9, 0x4c, 0xd5, 0x75, 0xab, 0xf6, 0x60,
    0x9c, 0x39, 0x76, 0xdb,
  ]);
  const WRAPPED_CIPHERTEXT = new Uint8Array([
    0xc1, 0x3a, 0x4d, 0x68, 0x5e, 0x8e, 0xcb, 0x26, 0x01, 0x82, 0x89, 0x72,
    0xa1, 0x28, 0x79, 0xf2, 0xb6, 0xd7, 0x46, 0xfd, 0x55, 0x4b, 0xe3, 0xc4,
    0xbf, 0x55, 0xee, 0xee, 0xfe, 0x11, 0x1b, 0x24,
  ]);

  const GOLDEN_AUTH_REQUEST: AuthRequest = {
    sessionId: GOLDEN_SESSION_ID,
    receiverDeviceId: 'device-bob',
    receiverPublicKey: RECEIVER_PUB_KEY,
    timestamp: 1728120000000, // 2024-10-05T09:20:00.000Z
  };

  const GOLDEN_AUTH_RESPONSE_AUTHORIZED: AuthResponse = {
    sessionId: GOLDEN_SESSION_ID,
    receiverDeviceId: 'device-bob',
    state: 'authorized',
    keyEnvelope: {
      targetDeviceId: 'device-bob',
      ephemeralPublicKey: SENDER_PUB_KEY,
      wrappedSessionKey: {
        nonce: WRAP_NONCE,
        tag: WRAP_TAG,
        ciphertext: WRAPPED_CIPHERTEXT,
      },
    },
  };

  const GOLDEN_AUTH_RESPONSE_REJECTED: AuthResponse = {
    sessionId: GOLDEN_SESSION_ID,
    receiverDeviceId: 'device-bob',
    state: 'rejected',
    message: 'Authorization denied by sender',
  };

  const GOLDEN_AUTH_RESPONSE_PENDING: AuthResponse = {
    sessionId: GOLDEN_SESSION_ID,
    receiverDeviceId: 'device-bob',
    state: 'pending',
    message: 'Awaiting sender approval',
  };

  describe('AUTH_REQUEST (0x01)', () => {
    it('encodes and decodes golden AuthRequest with round-trip fidelity', () => {
      const encoded = ControlCodec.encodeAuthRequest(GOLDEN_AUTH_REQUEST);
      expect(encoded).toBeInstanceOf(Uint8Array);

      // Fixed 61 + deviceId length (10) = 71 bytes
      expect(encoded.length).toBe(71);

      // Wire layout checks
      expect(encoded[0]).toBe(0x01); // MessageType = 0x01
      expect(encoded[1]).toBe(0x01); // Version = 1
      expect(encoded[2]).toBe(0x00); // Reserved MSB
      expect(encoded[3]).toBe(0x00); // Reserved LSB
      expect(encoded[4]).toBe(0x09); // SessionId prefix
      expect(encoded[19]).toBe(0x95); // SessionId suffix
      expect(encoded[60]).toBe(10); // DeviceId length = 10 ('device-bob')

      expect(ControlCodec.getControlMessageType(encoded)).toBe(0x01);

      const decoded = ControlCodec.decodeAuthRequest(encoded);
      expect(decoded.sessionId).toBe(GOLDEN_AUTH_REQUEST.sessionId);
      expect(decoded.receiverDeviceId).toBe(GOLDEN_AUTH_REQUEST.receiverDeviceId);
      expect(decoded.timestamp).toBe(GOLDEN_AUTH_REQUEST.timestamp);
      expect(decoded.receiverPublicKey).toEqual(GOLDEN_AUTH_REQUEST.receiverPublicKey);
    });

    it('rejects truncated AuthRequest buffer', () => {
      const encoded = ControlCodec.encodeAuthRequest(GOLDEN_AUTH_REQUEST);
      const truncated = encoded.subarray(0, encoded.length - 1);
      expect(() => ControlCodec.decodeAuthRequest(truncated)).toThrow(
        TruncatedControlMessageError,
      );
    });

    it('rejects AuthRequest with trailing data', () => {
      const encoded = ControlCodec.encodeAuthRequest(GOLDEN_AUTH_REQUEST);
      const withTrailing = new Uint8Array(encoded.length + 2);
      withTrailing.set(encoded, 0);
      withTrailing.set([0xaa, 0xbb], encoded.length);
      expect(() => ControlCodec.decodeAuthRequest(withTrailing)).toThrow(
        TrailingDataControlMessageError,
      );
    });

    it('rejects unsupported version in AuthRequest', () => {
      const encoded = ControlCodec.encodeAuthRequest(GOLDEN_AUTH_REQUEST);
      encoded[1] = 99; // Version 99
      expect(() => ControlCodec.decodeAuthRequest(encoded)).toThrow(
        UnsupportedControlVersionError,
      );
    });

    it('rejects non-zero reserved bytes in AuthRequest', () => {
      const encoded = ControlCodec.encodeAuthRequest(GOLDEN_AUTH_REQUEST);
      encoded[2] = 0x01; // Non-zero reserved
      expect(() => ControlCodec.decodeAuthRequest(encoded)).toThrow(
        MalformedControlMessageError,
      );
    });

    it('rejects invalid message type when decoding AuthRequest', () => {
      const encoded = ControlCodec.encodeAuthRequest(GOLDEN_AUTH_REQUEST);
      encoded[0] = 0x02; // Change to AuthResponse
      expect(() => ControlCodec.decodeAuthRequest(encoded)).toThrow(
        InvalidControlMessageTypeError,
      );
    });

    it('rejects invalid receiver public key length on encode', () => {
      expect(() =>
        ControlCodec.encodeAuthRequest({
          ...GOLDEN_AUTH_REQUEST,
          receiverPublicKey: new Uint8Array(16), // Invalid size
        }),
      ).toThrow(InvalidControlFieldError);
    });

    it('rejects empty or oversized receiver device ID on encode', () => {
      expect(() =>
        ControlCodec.encodeAuthRequest({
          ...GOLDEN_AUTH_REQUEST,
          receiverDeviceId: '', // Empty
        }),
      ).toThrow(InvalidControlFieldError);

      expect(() =>
        ControlCodec.encodeAuthRequest({
          ...GOLDEN_AUTH_REQUEST,
          receiverDeviceId: 'a'.repeat(65), // > 64
        }),
      ).toThrow(InvalidControlFieldError);
    });
  });

  describe('AUTH_RESPONSE / KEY_ENVELOPE (0x02)', () => {
    it('encodes and decodes golden Authorized AuthResponse with KeyEnvelope', () => {
      const encoded = ControlCodec.encodeAuthResponse(GOLDEN_AUTH_RESPONSE_AUTHORIZED);
      expect(encoded).toBeInstanceOf(Uint8Array);

      // Fixed 113 + deviceId length (10) = 123 bytes
      expect(encoded.length).toBe(123);

      // Wire layout checks
      expect(encoded[0]).toBe(0x02); // MessageType = 0x02
      expect(encoded[1]).toBe(0x01); // Version = 1
      expect(encoded[2]).toBe(0x01); // AuthState = 0x01 (authorized)
      expect(encoded[3]).toBe(0x00); // Reason / statusFlags = 0
      expect(encoded[4]).toBe(0x09); // SessionId prefix
      expect(encoded[20]).toBe(10); // TargetDeviceId length = 10 ('device-bob')

      expect(ControlCodec.getControlMessageType(encoded)).toBe(0x02);

      const { response, reasonCode } = ControlCodec.decodeAuthResponse(encoded);
      expect(reasonCode).toBe(0);
      expect(response.sessionId).toBe(GOLDEN_AUTH_RESPONSE_AUTHORIZED.sessionId);
      expect(response.receiverDeviceId).toBe(GOLDEN_AUTH_RESPONSE_AUTHORIZED.receiverDeviceId);
      expect(response.state).toBe('authorized');
      expect(response.keyEnvelope).toBeDefined();

      const env = response.keyEnvelope!;
      expect(env.targetDeviceId).toBe('device-bob');
      expect(env.ephemeralPublicKey).toEqual(SENDER_PUB_KEY);
      expect(env.wrappedSessionKey.nonce).toEqual(WRAP_NONCE);
      expect(env.wrappedSessionKey.tag).toEqual(WRAP_TAG);
      expect(env.wrappedSessionKey.ciphertext).toEqual(WRAPPED_CIPHERTEXT);
    });

    it('encodes and decodes golden Rejected AuthResponse without KeyEnvelope', () => {
      const encoded = ControlCodec.encodeAuthResponse(GOLDEN_AUTH_RESPONSE_REJECTED, 0x05);
      expect(encoded).toBeInstanceOf(Uint8Array);

      // Fixed 21 + deviceId length (10) = 31 bytes
      expect(encoded.length).toBe(31);

      expect(encoded[0]).toBe(0x02);
      expect(encoded[1]).toBe(0x01);
      expect(encoded[2]).toBe(0x02); // Rejected
      expect(encoded[3]).toBe(0x05); // Reason code 5

      const { response, reasonCode } = ControlCodec.decodeAuthResponse(encoded);
      expect(reasonCode).toBe(0x05);
      expect(response.sessionId).toBe(GOLDEN_AUTH_RESPONSE_REJECTED.sessionId);
      expect(response.state).toBe('rejected');
      expect(response.keyEnvelope).toBeUndefined();
    });

    it('encodes and decodes golden Pending AuthResponse without KeyEnvelope', () => {
      const encoded = ControlCodec.encodeAuthResponse(GOLDEN_AUTH_RESPONSE_PENDING);
      expect(encoded.length).toBe(31);

      expect(encoded[2]).toBe(0x03); // Pending

      const { response, reasonCode } = ControlCodec.decodeAuthResponse(encoded);
      expect(reasonCode).toBe(0);
      expect(response.sessionId).toBe(GOLDEN_AUTH_RESPONSE_PENDING.sessionId);
      expect(response.state).toBe('pending');
      expect(response.keyEnvelope).toBeUndefined();
    });

    it('rejects Authorized AuthResponse without keyEnvelope on encode', () => {
      expect(() =>
        ControlCodec.encodeAuthResponse({
          sessionId: GOLDEN_SESSION_ID,
          receiverDeviceId: 'device-bob',
          state: 'authorized',
        } as AuthResponse),
      ).toThrow(InvalidControlFieldError);
    });

    it('rejects truncated Authorized AuthResponse buffer', () => {
      const encoded = ControlCodec.encodeAuthResponse(GOLDEN_AUTH_RESPONSE_AUTHORIZED);
      const truncated = encoded.subarray(0, 100);
      expect(() => ControlCodec.decodeAuthResponse(truncated)).toThrow(
        TruncatedControlMessageError,
      );
    });

    it('rejects Authorized AuthResponse with trailing bytes', () => {
      const encoded = ControlCodec.encodeAuthResponse(GOLDEN_AUTH_RESPONSE_AUTHORIZED);
      const withTrailing = new Uint8Array(encoded.length + 3);
      withTrailing.set(encoded, 0);
      expect(() => ControlCodec.decodeAuthResponse(withTrailing)).toThrow(
        TrailingDataControlMessageError,
      );
    });

    it('rejects unsupported version in AuthResponse', () => {
      const encoded = ControlCodec.encodeAuthResponse(GOLDEN_AUTH_RESPONSE_AUTHORIZED);
      encoded[1] = 2; // Version 2
      expect(() => ControlCodec.decodeAuthResponse(encoded)).toThrow(
        UnsupportedControlVersionError,
      );
    });

    it('prints golden hex strings for Android parity test fixtures', () => {
      const reqHex = Buffer.from(ControlCodec.encodeAuthRequest(GOLDEN_AUTH_REQUEST)).toString('hex');
      const authHex = Buffer.from(ControlCodec.encodeAuthResponse(GOLDEN_AUTH_RESPONSE_AUTHORIZED)).toString('hex');
      const rejHex = Buffer.from(ControlCodec.encodeAuthResponse(GOLDEN_AUTH_RESPONSE_REJECTED, 5)).toString('hex');
      const pendHex = Buffer.from(ControlCodec.encodeAuthResponse(GOLDEN_AUTH_RESPONSE_PENDING)).toString('hex');

      console.log('GOLDEN_AUTH_REQUEST_HEX:', reqHex);
      console.log('GOLDEN_AUTH_RESPONSE_AUTHORIZED_HEX:', authHex);
      console.log('GOLDEN_AUTH_RESPONSE_REJECTED_HEX:', rejHex);
      console.log('GOLDEN_AUTH_RESPONSE_PENDING_HEX:', pendHex);
    });
  });
});

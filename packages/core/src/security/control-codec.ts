import type {
  AuthRequest,
  AuthResponse,
  EncryptedKeyEnvelope,
  ReceiverAuthState,
} from './types.js';
import { sessionIdToBytes, bytesToSessionId } from '../packet/binary-codec.js';

// ============================================================================
// Error Types
// ============================================================================

export class ControlCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlCodecError';
  }
}

export class TruncatedControlMessageError extends ControlCodecError {
  readonly expected: number;
  readonly actual: number;
  constructor(expected: number, actual: number) {
    super(`Truncated control message: expected at least ${expected} bytes, received ${actual}`);
    this.name = 'TruncatedControlMessageError';
    this.expected = expected;
    this.actual = actual;
  }
}

export class TrailingDataControlMessageError extends ControlCodecError {
  readonly expected: number;
  readonly actual: number;
  constructor(expected: number, actual: number) {
    super(
      `Trailing data detected: control message length is ${expected} bytes, received buffer of ${actual} bytes`,
    );
    this.name = 'TrailingDataControlMessageError';
    this.expected = expected;
    this.actual = actual;
  }
}

export class UnsupportedControlVersionError extends ControlCodecError {
  readonly version: number;
  constructor(version: number) {
    super(
      `Unsupported control version: ${version} (expected ${ControlCodec.CURRENT_VERSION})`,
    );
    this.name = 'UnsupportedControlVersionError';
    this.version = version;
  }
}

export class InvalidControlMessageTypeError extends ControlCodecError {
  readonly messageType: number;
  constructor(messageType: number) {
    super(`Invalid control message type: ${messageType}`);
    this.name = 'InvalidControlMessageTypeError';
    this.messageType = messageType;
  }
}

export class InvalidControlFieldError extends ControlCodecError {
  readonly fieldName: string;
  readonly value: unknown;
  constructor(fieldName: string, value: unknown, reason: string) {
    super(`Invalid control field '${fieldName}': ${reason} (value: ${String(value)})`);
    this.name = 'InvalidControlFieldError';
    this.fieldName = fieldName;
    this.value = value;
  }
}

export class MalformedControlMessageError extends ControlCodecError {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedControlMessageError';
  }
}

// ============================================================================
// Control Binary Codec
// ============================================================================

/**
 * Deterministic binary serializer and deserializer for CONTROL plane messages:
 * - AUTH_REQUEST (0x01)
 * - AUTH_RESPONSE / KEY_ENVELOPE (0x02)
 */
export class ControlCodec {
  static readonly CURRENT_VERSION = 1;

  static readonly TYPE_AUTH_REQUEST = 0x01;
  static readonly TYPE_AUTH_RESPONSE = 0x02;

  static readonly AUTH_STATE_AUTHORIZED = 0x01;
  static readonly AUTH_STATE_REJECTED = 0x02;
  static readonly AUTH_STATE_PENDING = 0x03;

  static readonly AUTH_REQUEST_FIXED_SIZE = 61;
  static readonly AUTH_RESPONSE_AUTHORIZED_FIXED_SIZE = 113;
  static readonly AUTH_RESPONSE_NON_AUTHORIZED_FIXED_SIZE = 21;

  static readonly MIN_DEVICE_ID_LENGTH = 1;
  static readonly MAX_DEVICE_ID_LENGTH = 64;

  private static readonly textEncoder = new TextEncoder();
  private static readonly textDecoder = new TextDecoder('utf-8', { fatal: true });

  /**
   * Reads the 1-byte control message type discriminator without full decoding.
   */
  static getControlMessageType(raw: Uint8Array): number {
    if (raw.length < 1) {
      throw new TruncatedControlMessageError(1, raw.length);
    }
    return raw[0]!;
  }

  // ==========================================================================
  // AUTH_REQUEST (0x01)
  // ==========================================================================

  /**
   * Encodes an AuthRequest into a deterministic binary buffer.
   *
   * Layout:
   *   [0]      MessageType = 0x01 (uint8)
   *   [1]      Version = 0x01 (uint8)
   *   [2..3]   Reserved = 0x0000 (uint16 BE)
   *   [4..19]  Session ID (16 bytes)
   *   [20..27] Timestamp (uint64 BE, ms)
   *   [28..59] Receiver Public Key (32 bytes X25519)
   *   [60]     Receiver Device ID Length N (uint8, 1..64)
   *   [61..60+N] Receiver Device ID (UTF-8 bytes)
   *
   * Total length: 61 + N bytes.
   */
  static encodeAuthRequest(request: AuthRequest): Uint8Array {
    if (request.timestamp < 0) {
      throw new InvalidControlFieldError('timestamp', request.timestamp, 'Must be >= 0');
    }

    if (!request.receiverPublicKey || request.receiverPublicKey.length !== 32) {
      throw new InvalidControlFieldError(
        'receiverPublicKey',
        request.receiverPublicKey?.length,
        'Must be exactly 32 bytes',
      );
    }

    const sessionBytes = sessionIdToBytes(request.sessionId);
    const deviceIdBytes = this.textEncoder.encode(request.receiverDeviceId);

    if (deviceIdBytes.length < this.MIN_DEVICE_ID_LENGTH) {
      throw new InvalidControlFieldError(
        'receiverDeviceId',
        request.receiverDeviceId,
        `Length must be at least ${this.MIN_DEVICE_ID_LENGTH} byte`,
      );
    }
    if (deviceIdBytes.length > this.MAX_DEVICE_ID_LENGTH) {
      throw new InvalidControlFieldError(
        'receiverDeviceId',
        request.receiverDeviceId,
        `Length (${deviceIdBytes.length}) exceeds maximum ${this.MAX_DEVICE_ID_LENGTH} bytes`,
      );
    }

    const totalLength = this.AUTH_REQUEST_FIXED_SIZE + deviceIdBytes.length;
    const buffer = new Uint8Array(totalLength);
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    // [0] MessageType
    buffer[0] = this.TYPE_AUTH_REQUEST;
    // [1] Version
    buffer[1] = this.CURRENT_VERSION;
    // [2..3] Reserved
    view.setUint16(2, 0x0000, false);
    // [4..19] Session ID
    buffer.set(sessionBytes, 4);
    // [20..27] Timestamp
    view.setBigUint64(20, BigInt(Math.floor(request.timestamp)), false);
    // [28..59] Receiver Public Key
    buffer.set(request.receiverPublicKey, 28);
    // [60] Device ID Length
    buffer[60] = deviceIdBytes.length;
    // [61..] Device ID
    buffer.set(deviceIdBytes, 61);

    return buffer;
  }

  /**
   * Decodes an AuthRequest from a raw binary buffer with strict validation.
   */
  static decodeAuthRequest(raw: Uint8Array): AuthRequest {
    if (raw.length < this.AUTH_REQUEST_FIXED_SIZE + this.MIN_DEVICE_ID_LENGTH) {
      throw new TruncatedControlMessageError(
        this.AUTH_REQUEST_FIXED_SIZE + this.MIN_DEVICE_ID_LENGTH,
        raw.length,
      );
    }

    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

    // 1. Message Type
    const messageType = raw[0]!;
    if (messageType !== this.TYPE_AUTH_REQUEST) {
      throw new InvalidControlMessageTypeError(messageType);
    }

    // 2. Version
    const version = raw[1]!;
    if (version !== this.CURRENT_VERSION) {
      throw new UnsupportedControlVersionError(version);
    }

    // 3. Reserved (must be 0x0000)
    const reserved = view.getUint16(2, false);
    if (reserved !== 0x0000) {
      throw new MalformedControlMessageError(
        `Invalid reserved field: expected 0x0000, received 0x${reserved.toString(16)}`,
      );
    }

    // 4. Session ID
    const sessionBytes = raw.subarray(4, 20);
    const sessionId = bytesToSessionId(sessionBytes);

    // 5. Timestamp
    const timestampBig = view.getBigUint64(20, false);
    const timestamp = Number(timestampBig);

    // 6. Receiver Public Key
    const receiverPublicKey = new Uint8Array(raw.subarray(28, 60));

    // 7. Device ID
    const deviceIdLength = raw[60]!;
    if (
      deviceIdLength < this.MIN_DEVICE_ID_LENGTH ||
      deviceIdLength > this.MAX_DEVICE_ID_LENGTH
    ) {
      throw new InvalidControlFieldError(
        'receiverDeviceIdLength',
        deviceIdLength,
        `Must be between ${this.MIN_DEVICE_ID_LENGTH} and ${this.MAX_DEVICE_ID_LENGTH} bytes`,
      );
    }

    const expectedTotal = this.AUTH_REQUEST_FIXED_SIZE + deviceIdLength;
    if (raw.length < expectedTotal) {
      throw new TruncatedControlMessageError(expectedTotal, raw.length);
    }
    if (raw.length > expectedTotal) {
      throw new TrailingDataControlMessageError(expectedTotal, raw.length);
    }

    let receiverDeviceId: string;
    try {
      receiverDeviceId = this.textDecoder.decode(raw.subarray(61, expectedTotal));
    } catch {
      throw new MalformedControlMessageError('Invalid UTF-8 sequence in receiverDeviceId');
    }

    return {
      sessionId,
      receiverDeviceId,
      receiverPublicKey,
      timestamp,
    };
  }

  // ==========================================================================
  // AUTH_RESPONSE / KEY_ENVELOPE (0x02)
  // ==========================================================================

  /**
   * Encodes an AuthResponse (and optional EncryptedKeyEnvelope) into a deterministic binary buffer.
   *
   * Layout:
   *   [0]        MessageType = 0x02 (uint8)
   *   [1]        Version = 0x01 (uint8)
   *   [2]        AuthState (uint8: 0x01=authorized, 0x02=rejected, 0x03=pending)
   *   [3]        StatusFlags/Reason (uint8)
   *   [4..19]    Session ID (16 bytes)
   *   [20]       Target Device ID Length N (uint8, 1..64)
   *   [21..20+N] Target Device ID (UTF-8 bytes)
   *
   * If authorized (state == 0x01):
   *   [21+N..52+N]  Ephemeral Public Key (32 bytes X25519)
   *   [53+N..64+N]  Wrap Nonce (12 bytes)
   *   [65+N..80+N]  Wrap Tag (16 bytes)
   *   [81+N..112+N] Wrapped Session Key Ciphertext (32 bytes)
   *
   * Total length: 113 + N bytes (authorized) or 21 + N bytes (rejected/pending).
   */
  static encodeAuthResponse(
    response: AuthResponse,
    reasonCode: number = 0,
  ): Uint8Array {
    let stateByte: number;
    switch (response.state) {
      case 'authorized':
        stateByte = this.AUTH_STATE_AUTHORIZED;
        break;
      case 'rejected':
        stateByte = this.AUTH_STATE_REJECTED;
        break;
      case 'pending':
        stateByte = this.AUTH_STATE_PENDING;
        break;
      default:
        throw new InvalidControlFieldError(
          'state',
          response.state,
          "Must be 'authorized', 'rejected', or 'pending'",
        );
    }

    const sessionBytes = sessionIdToBytes(response.sessionId);
    const targetDeviceId = response.keyEnvelope?.targetDeviceId ?? response.receiverDeviceId;
    const deviceIdBytes = this.textEncoder.encode(targetDeviceId);

    if (deviceIdBytes.length < this.MIN_DEVICE_ID_LENGTH) {
      throw new InvalidControlFieldError(
        'targetDeviceId',
        targetDeviceId,
        `Length must be at least ${this.MIN_DEVICE_ID_LENGTH} byte`,
      );
    }
    if (deviceIdBytes.length > this.MAX_DEVICE_ID_LENGTH) {
      throw new InvalidControlFieldError(
        'targetDeviceId',
        targetDeviceId,
        `Length (${deviceIdBytes.length}) exceeds maximum ${this.MAX_DEVICE_ID_LENGTH} bytes`,
      );
    }

    const isAuthorized = stateByte === this.AUTH_STATE_AUTHORIZED;
    if (isAuthorized && !response.keyEnvelope) {
      throw new InvalidControlFieldError(
        'keyEnvelope',
        undefined,
        "keyEnvelope is required when state is 'authorized'",
      );
    }

    const envelope = response.keyEnvelope;
    if (isAuthorized && envelope) {
      if (
        !envelope.ephemeralPublicKey ||
        envelope.ephemeralPublicKey.length !== 32
      ) {
        throw new InvalidControlFieldError(
          'ephemeralPublicKey',
          envelope.ephemeralPublicKey?.length,
          'Must be exactly 32 bytes',
        );
      }
      if (
        !envelope.wrappedSessionKey.nonce ||
        envelope.wrappedSessionKey.nonce.length !== 12
      ) {
        throw new InvalidControlFieldError(
          'wrapNonce',
          envelope.wrappedSessionKey.nonce?.length,
          'Must be exactly 12 bytes',
        );
      }
      if (
        !envelope.wrappedSessionKey.tag ||
        envelope.wrappedSessionKey.tag.length !== 16
      ) {
        throw new InvalidControlFieldError(
          'wrapTag',
          envelope.wrappedSessionKey.tag?.length,
          'Must be exactly 16 bytes',
        );
      }
      if (
        !envelope.wrappedSessionKey.ciphertext ||
        envelope.wrappedSessionKey.ciphertext.length !== 32
      ) {
        throw new InvalidControlFieldError(
          'wrappedCiphertext',
          envelope.wrappedSessionKey.ciphertext?.length,
          'Must be exactly 32 bytes',
        );
      }
    }

    const totalLength = isAuthorized
      ? this.AUTH_RESPONSE_AUTHORIZED_FIXED_SIZE + deviceIdBytes.length
      : this.AUTH_RESPONSE_NON_AUTHORIZED_FIXED_SIZE + deviceIdBytes.length;

    const buffer = new Uint8Array(totalLength);

    // [0] MessageType
    buffer[0] = this.TYPE_AUTH_RESPONSE;
    // [1] Version
    buffer[1] = this.CURRENT_VERSION;
    // [2] AuthState
    buffer[2] = stateByte;
    // [3] StatusFlags / Reason
    buffer[3] = reasonCode & 0xff;
    // [4..19] Session ID
    buffer.set(sessionBytes, 4);
    // [20] Target Device ID Length
    buffer[20] = deviceIdBytes.length;
    // [21..20+N] Target Device ID
    buffer.set(deviceIdBytes, 21);

    if (isAuthorized && envelope) {
      let offset = 21 + deviceIdBytes.length;
      // Ephemeral Public Key (32 bytes)
      buffer.set(envelope.ephemeralPublicKey, offset);
      offset += 32;
      // Wrap Nonce (12 bytes)
      buffer.set(envelope.wrappedSessionKey.nonce, offset);
      offset += 12;
      // Wrap Tag (16 bytes)
      buffer.set(envelope.wrappedSessionKey.tag, offset);
      offset += 16;
      // Wrapped Ciphertext (32 bytes)
      buffer.set(envelope.wrappedSessionKey.ciphertext, offset);
    }

    return buffer;
  }

  /**
   * Decodes an AuthResponse from a raw binary buffer with strict validation.
   */
  static decodeAuthResponse(raw: Uint8Array): {
    response: AuthResponse;
    reasonCode: number;
  } {
    if (raw.length < this.AUTH_RESPONSE_NON_AUTHORIZED_FIXED_SIZE + this.MIN_DEVICE_ID_LENGTH) {
      throw new TruncatedControlMessageError(
        this.AUTH_RESPONSE_NON_AUTHORIZED_FIXED_SIZE + this.MIN_DEVICE_ID_LENGTH,
        raw.length,
      );
    }

    // 1. Message Type
    const messageType = raw[0]!;
    if (messageType !== this.TYPE_AUTH_RESPONSE) {
      throw new InvalidControlMessageTypeError(messageType);
    }

    // 2. Version
    const version = raw[1]!;
    if (version !== this.CURRENT_VERSION) {
      throw new UnsupportedControlVersionError(version);
    }

    // 3. Auth State
    const stateByte = raw[2]!;
    let state: ReceiverAuthState;
    if (stateByte === this.AUTH_STATE_AUTHORIZED) {
      state = 'authorized';
    } else if (stateByte === this.AUTH_STATE_REJECTED) {
      state = 'rejected';
    } else if (stateByte === this.AUTH_STATE_PENDING) {
      state = 'pending';
    } else {
      throw new InvalidControlFieldError(
        'authState',
        stateByte,
        'Expected 1 (authorized), 2 (rejected), or 3 (pending)',
      );
    }

    // 4. StatusFlags / Reason Code
    const reasonCode = raw[3]!;

    // 5. Session ID
    const sessionBytes = raw.subarray(4, 20);
    const sessionId = bytesToSessionId(sessionBytes);

    // 6. Target Device ID
    const deviceIdLength = raw[20]!;
    if (
      deviceIdLength < this.MIN_DEVICE_ID_LENGTH ||
      deviceIdLength > this.MAX_DEVICE_ID_LENGTH
    ) {
      throw new InvalidControlFieldError(
        'targetDeviceIdLength',
        deviceIdLength,
        `Must be between ${this.MIN_DEVICE_ID_LENGTH} and ${this.MAX_DEVICE_ID_LENGTH} bytes`,
      );
    }

    const isAuthorized = stateByte === this.AUTH_STATE_AUTHORIZED;
    const expectedTotal = isAuthorized
      ? this.AUTH_RESPONSE_AUTHORIZED_FIXED_SIZE + deviceIdLength
      : this.AUTH_RESPONSE_NON_AUTHORIZED_FIXED_SIZE + deviceIdLength;

    if (raw.length < expectedTotal) {
      throw new TruncatedControlMessageError(expectedTotal, raw.length);
    }
    if (raw.length > expectedTotal) {
      throw new TrailingDataControlMessageError(expectedTotal, raw.length);
    }

    let targetDeviceId: string;
    try {
      targetDeviceId = this.textDecoder.decode(raw.subarray(21, 21 + deviceIdLength));
    } catch {
      throw new MalformedControlMessageError('Invalid UTF-8 sequence in targetDeviceId');
    }

    let keyEnvelope: EncryptedKeyEnvelope | undefined = undefined;

    if (isAuthorized) {
      let offset = 21 + deviceIdLength;
      const ephemeralPublicKey = new Uint8Array(raw.subarray(offset, offset + 32));
      offset += 32;
      const nonce = new Uint8Array(raw.subarray(offset, offset + 12));
      offset += 12;
      const tag = new Uint8Array(raw.subarray(offset, offset + 16));
      offset += 16;
      const ciphertext = new Uint8Array(raw.subarray(offset, offset + 32));

      keyEnvelope = {
        targetDeviceId,
        ephemeralPublicKey,
        wrappedSessionKey: {
          ciphertext,
          nonce,
          tag,
        },
      };
    }

    const response: AuthResponse = keyEnvelope !== undefined
      ? {
          sessionId,
          receiverDeviceId: targetDeviceId,
          state,
          keyEnvelope,
        }
      : {
          sessionId,
          receiverDeviceId: targetDeviceId,
          state,
        };

    return {
      response,
      reasonCode,
    };
  }
}

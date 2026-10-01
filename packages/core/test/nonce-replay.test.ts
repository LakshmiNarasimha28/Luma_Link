import { describe, it, expect } from 'vitest';
import {
  NonceManager,
  NONCE_LENGTH_BYTES,
  SALT_PREFIX_LENGTH_BYTES,
  buildDomainTag,
} from '../src/security/nonce.js';
import { ReplayProtector } from '../src/security/replay-protector.js';
import { SecurityError, ReplayError } from '../src/security/types.js';

describe('Nonce Construction & Replay Protection', () => {
  describe('NonceManager', () => {
    const saltPrefix = new Uint8Array([0xde, 0xad, 0xbe]);

    it('constructs standard 12-byte structured nonces with domain & direction separation', () => {
      const manager = new NonceManager(saltPrefix);
      const nonce = manager.generateNonce(42, 108, 2, 'sender');

      expect(nonce.length).toBe(NONCE_LENGTH_BYTES);
      // Byte 0 is domain tag (0x02 for sender data)
      expect(nonce[0]).toBe(buildDomainTag('sender', 2));
      // Bytes 1..3 are salt prefix
      expect(nonce.subarray(1, 4)).toEqual(saltPrefix);

      const parsed = NonceManager.parseNonce(nonce);
      expect(parsed.direction).toBe('sender');
      expect(parsed.packetTypeCode).toBe(2);
      expect(parsed.saltPrefix).toEqual(saltPrefix);
      expect(parsed.blockIndex).toBe(42);
      expect(parsed.symbolId).toBe(108);
    });

    it('proves DATA and CONTROL nonces are mathematically disjoint', () => {
      const manager = new NonceManager(saltPrefix);
      const dataNonce = manager.generateNonce(0, 0, 2, 'sender'); // DATA
      const controlNonce = manager.generateNonce(0, 0, 4, 'sender'); // CONTROL

      expect(dataNonce[0]).not.toBe(controlNonce[0]);
      expect(dataNonce).not.toEqual(controlNonce);
      // First byte differs: 0x02 (DATA) vs 0x04 (CONTROL)
      expect(dataNonce[0]).toBe(0x02);
      expect(controlNonce[0]).toBe(0x04);
    });

    it('proves Sender and Receiver nonces are mathematically disjoint via direction bit', () => {
      const manager = new NonceManager(saltPrefix);
      const senderControl = manager.generateNonce(0, 0, 4, 'sender');
      const receiverControl = manager.generateNonce(0, 0, 4, 'receiver');

      expect(senderControl[0]).not.toBe(receiverControl[0]);
      expect(senderControl).not.toEqual(receiverControl);
      // Bit 7 is 0 for sender (0x04) and 1 for receiver (0x84)
      expect(senderControl[0]).toBe(0x04);
      expect(receiverControl[0]).toBe(0x84);
    });

    it('enforces cryptographic invariant: throws SecurityError on nonce reuse attempt', () => {
      const manager = new NonceManager(saltPrefix);

      // First call for (block=0, sym=1) succeeds
      expect(manager.generateNonce(0, 1, 2, 'sender')).toBeInstanceOf(Uint8Array);

      // Second call under the same domain, direction, and sequence throws
      expect(() => manager.generateNonce(0, 1, 2, 'sender')).toThrow(SecurityError);
    });

    it('rejects salt prefixes that are not exactly 3 bytes', () => {
      expect(() => new NonceManager(new Uint8Array([1, 2]))).toThrow(RangeError);
      expect(() => new NonceManager(new Uint8Array(4))).toThrow(RangeError);
      expect(SALT_PREFIX_LENGTH_BYTES).toBe(3);
    });
  });

  describe('ReplayProtector Domain Separation & Out-of-Order Support', () => {
    it('proves DATA(0, 0) does NOT block CONTROL(0, 0)', () => {
      const protector = new ReplayProtector();

      // Record a CONTROL packet at (block=0, sym=0)
      expect(protector.checkAndRecord(0, 0, false, 4, 'sender')).toBe(true);

      // Subsequent DATA packet at (block=0, sym=0) MUST be accepted (different domain)
      expect(protector.checkAndRecord(0, 0, false, 2, 'sender')).toBe(true);

      expect(protector.stats.uniqueAccepted).toBe(2);
      expect(protector.stats.replaysDetected).toBe(0);
    });

    it('proves sender and receiver domains do not collide', () => {
      const protector = new ReplayProtector();

      // Sender sends CONTROL(0, 0)
      expect(protector.checkAndRecord(0, 0, false, 4, 'sender')).toBe(true);

      // Receiver sends CONTROL(0, 0) - MUST be accepted (different direction)
      expect(protector.checkAndRecord(0, 0, false, 4, 'receiver')).toBe(true);

      expect(protector.stats.uniqueAccepted).toBe(2);
      expect(protector.stats.replaysDetected).toBe(0);
    });

    it('rejects duplicates within the same domain and direction', () => {
      const protector = new ReplayProtector();

      expect(protector.checkAndRecord(0, 10, false, 2, 'sender')).toBe(true);
      expect(protector.checkAndRecord(0, 10, false, 2, 'sender')).toBe(false); // Replayed!

      expect(protector.stats.totalChecked).toBe(2);
      expect(protector.stats.uniqueAccepted).toBe(1);
      expect(protector.stats.replaysDetected).toBe(1);
    });

    it('preserves out-of-order fountain packet reception', () => {
      const protector = new ReplayProtector();

      // Fountain packets can arrive in arbitrary order: 10, 2, 5, 1
      expect(protector.checkAndRecord(0, 10, false, 2, 'sender')).toBe(true);
      expect(protector.checkAndRecord(0, 2, false, 2, 'sender')).toBe(true);
      expect(protector.checkAndRecord(0, 5, false, 2, 'sender')).toBe(true);
      expect(protector.checkAndRecord(0, 1, false, 2, 'sender')).toBe(true);

      // Replaying symbol 5 must be rejected
      expect(protector.checkAndRecord(0, 5, false, 2, 'sender')).toBe(false);

      expect(protector.stats.uniqueAccepted).toBe(4);
      expect(protector.stats.replaysDetected).toBe(1);
    });

    it('throws ReplayError when throwOnReplay is true', () => {
      const protector = new ReplayProtector();

      protector.checkAndRecord(1, 5, false, 2, 'sender');
      expect(() => protector.checkAndRecord(1, 5, true, 2, 'sender')).toThrow(ReplayError);
    });

    it('resets tracking state on reset()', () => {
      const protector = new ReplayProtector();

      protector.checkAndRecord(0, 1, false, 2, 'sender');
      expect(protector.isSeen(0, 1, 2, 'sender')).toBe(true);

      protector.reset();
      expect(protector.isSeen(0, 1, 2, 'sender')).toBe(false);
      expect(protector.checkAndRecord(0, 1, false, 2, 'sender')).toBe(true);
    });
  });
});

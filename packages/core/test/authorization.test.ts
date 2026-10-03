import { describe, it, expect } from 'vitest';
import { NodeCryptoProvider } from '../src/platform/node/index.js';
import { AuthorizationManager } from '../src/security/authorization.js';
import { SessionSecurityContext, deriveSessionKeys } from '../src/security/security-context.js';
import { DecryptionError, ReplayError } from '../src/security/types.js';

describe('Authorization & Session Security Context', () => {
  const crypto = new NodeCryptoProvider();
  const sessionId = '11223344-5566-7788-99aa-bbccddeeff00';

  describe('Quick Send Authorization Policy & Key Distribution', () => {
    it('automatically authorizes receiver requests and issues wrapped key envelope', () => {
      const senderEph = crypto.generateKeyPair();
      const masterSecret = crypto.randomBytes(32);

      const authMgr = new AuthorizationManager(
        sessionId,
        'quick',
        senderEph.privateKey,
        senderEph.publicKey,
        masterSecret,
        crypto,
      );

      const receiverKey = crypto.generateKeyPair();
      const response = authMgr.handleAuthRequest({
        sessionId,
        receiverDeviceId: 'device-bob',
        receiverPublicKey: receiverKey.publicKey,
        timestamp: Date.now(),
      });

      expect(response.state).toBe('authorized');
      expect(response.keyEnvelope).toBeDefined();
      expect(authMgr.isAuthorized('device-bob')).toBe(true);

      // Receiver unwraps and recovers identical master session secret
      const unwrapped = AuthorizationManager.unwrapKeyEnvelope(
        response.keyEnvelope!,
        receiverKey.privateKey,
        sessionId,
        crypto,
      );
      expect(unwrapped).toEqual(masterSecret);
    });

    it('allows multiple independent receivers to obtain the identical broadcast session key', () => {
      const senderEph = crypto.generateKeyPair();
      const broadcastMasterSecret = crypto.randomBytes(32);

      const authMgr = new AuthorizationManager(
        sessionId,
        'quick',
        senderEph.privateKey,
        senderEph.publicKey,
        broadcastMasterSecret,
        crypto,
      );

      // Receiver A
      const receiverAKey = crypto.generateKeyPair();
      const responseA = authMgr.handleAuthRequest({
        sessionId,
        receiverDeviceId: 'device-alice',
        receiverPublicKey: receiverAKey.publicKey,
        timestamp: Date.now(),
      });

      // Receiver B
      const receiverBKey = crypto.generateKeyPair();
      const responseB = authMgr.handleAuthRequest({
        sessionId,
        receiverDeviceId: 'device-bob',
        receiverPublicKey: receiverBKey.publicKey,
        timestamp: Date.now(),
      });

      // Envelopes are personalized and distinct
      expect(responseA.keyEnvelope).toBeDefined();
      expect(responseB.keyEnvelope).toBeDefined();
      expect(responseA.keyEnvelope?.targetDeviceId).toBe('device-alice');
      expect(responseB.keyEnvelope?.targetDeviceId).toBe('device-bob');

      // Both unwrap the EXACT SAME broadcast master secret
      const secretA = AuthorizationManager.unwrapKeyEnvelope(
        responseA.keyEnvelope!,
        receiverAKey.privateKey,
        sessionId,
        crypto,
      );
      const secretB = AuthorizationManager.unwrapKeyEnvelope(
        responseB.keyEnvelope!,
        receiverBKey.privateKey,
        sessionId,
        crypto,
      );

      expect(secretA).toEqual(broadcastMasterSecret);
      expect(secretB).toEqual(broadcastMasterSecret);
      expect(secretA).toEqual(secretB);
    });

    it('prevents passive observer / eavesdropper from unwrapping another receiver envelope', () => {
      const senderEph = crypto.generateKeyPair();
      const masterSecret = crypto.randomBytes(32);

      const authMgr = new AuthorizationManager(
        sessionId,
        'quick',
        senderEph.privateKey,
        senderEph.publicKey,
        masterSecret,
        crypto,
      );

      const receiverKey = crypto.generateKeyPair();
      const response = authMgr.handleAuthRequest({
        sessionId,
        receiverDeviceId: 'device-bob',
        receiverPublicKey: receiverKey.publicKey,
        timestamp: Date.now(),
      });

      // Passive eavesdropper (Eve) attempts to unwrap Bob's key envelope
      const eveKey = crypto.generateKeyPair();
      expect(() =>
        AuthorizationManager.unwrapKeyEnvelope(
          response.keyEnvelope!,
          eveKey.privateKey,
          sessionId,
          crypto,
        ),
      ).toThrow(DecryptionError);
    });
  });

  describe('Private Send Authorization Policy', () => {
    it('requires explicit sender approval and securely encapsulates the session key', () => {
      const senderEph = crypto.generateKeyPair();
      const masterSecret = crypto.randomBytes(32);

      const authMgr = new AuthorizationManager(
        sessionId,
        'private',
        senderEph.privateKey,
        senderEph.publicKey,
        masterSecret,
        crypto,
      );

      const bobKey = crypto.generateKeyPair();
      const req = {
        sessionId,
        receiverDeviceId: 'device-bob',
        receiverPublicKey: bobKey.publicKey,
        timestamp: Date.now(),
      };

      // 1. Initial request -> Pending (no key envelope returned)
      const pendingRes = authMgr.handleAuthRequest(req);
      expect(pendingRes.state).toBe('pending');
      expect(pendingRes.keyEnvelope).toBeUndefined();
      expect(authMgr.isAuthorized('device-bob')).toBe(false);

      // 2. Sender approves Bob
      const approvalRes = authMgr.approveReceiver('device-bob');
      expect(approvalRes.state).toBe('authorized');
      expect(approvalRes.keyEnvelope).toBeDefined();
      expect(authMgr.isAuthorized('device-bob')).toBe(true);

      // 3. Bob unwraps key envelope using his private key
      const unwrappedSecret = AuthorizationManager.unwrapKeyEnvelope(
        approvalRes.keyEnvelope!,
        bobKey.privateKey,
        sessionId,
        crypto,
      );

      expect(unwrappedSecret).toEqual(masterSecret);

      // 4. Rogue receiver (Eve) cannot unwrap Bob's key envelope
      const eveKey = crypto.generateKeyPair();
      expect(() =>
        AuthorizationManager.unwrapKeyEnvelope(
          approvalRes.keyEnvelope!,
          eveKey.privateKey,
          sessionId,
          crypto,
        ),
      ).toThrow(DecryptionError);
    });

    it('rejects receivers when explicitly denied by sender', () => {
      const senderEph = crypto.generateKeyPair();
      const masterSecret = crypto.randomBytes(32);

      const authMgr = new AuthorizationManager(
        sessionId,
        'private',
        senderEph.privateKey,
        senderEph.publicKey,
        masterSecret,
        crypto,
      );

      const req = {
        sessionId,
        receiverDeviceId: 'device-charlie',
        receiverPublicKey: crypto.generateKeyPair().publicKey,
        timestamp: Date.now(),
      };

      authMgr.handleAuthRequest(req);
      const rejection = authMgr.rejectReceiver('device-charlie', 'Untrusted device');

      expect(rejection.state).toBe('rejected');
      expect(rejection.keyEnvelope).toBeUndefined();
      expect(authMgr.isAuthorized('device-charlie')).toBe(false);
    });
  });

  describe('SessionSecurityContext & AAD Binding', () => {
    const masterSecret = crypto.randomBytes(32);
    const keys = deriveSessionKeys(masterSecret, sessionId, 'private', crypto);
    const context = new SessionSecurityContext(sessionId, 'private', keys, crypto);

    it('packs tag and ciphertext into wire payload and decrypts successfully', () => {
      const plaintext = new TextEncoder().encode('Confidential Optical Frame Data');
      const wire = context.encryptToWirePayload(0, 1, plaintext);

      expect(wire.length).toBe(16 + plaintext.length);

      const decrypted = context.decryptFromWirePayload(0, 1, wire);
      expect(decrypted).toEqual(plaintext);
    });

    it('rejects replayed wire payloads under replay protection', () => {
      const plaintext = new TextEncoder().encode('Once Only Message');
      const wire = context.encryptToWirePayload(0, 99, plaintext);

      // First decryption passes
      expect(context.decryptFromWirePayload(0, 99, wire)).toEqual(plaintext);

      // Second decryption with same (block=0, sym=99) throws ReplayError
      expect(() => context.decryptFromWirePayload(0, 99, wire)).toThrow(ReplayError);
    });

    it('rejects wire payloads if block index or symbol ID are swapped in transit', () => {
      const plaintext = new TextEncoder().encode('Bound to block 0, sym 5');
      const wire = context.encryptToWirePayload(0, 5, plaintext);

      // Attempting to decrypt with different blockIndex fails AAD verification
      expect(() => context.decryptFromWirePayload(1, 5, wire)).toThrow(DecryptionError);

      // Attempting to decrypt with different symbolId fails AAD verification
      expect(() => context.decryptFromWirePayload(0, 6, wire)).toThrow(DecryptionError);
    });
  });
});

import { describe, it, expect } from 'vitest';
import {
  FileBlocker,
  SenderSession,
  ReceiverSession,
  SimulatedChannel,
  BinaryPacketCodec,
  computeSha256,
  DecryptionError,
  AuthorizationManager,
} from '@lumalink/core';
import { NodeCryptoProvider } from '@lumalink/core/node';

describe('Phase 2 Encrypted Transfer Pipeline Integration', () => {
  const crypto = new NodeCryptoProvider();
  const codec = new BinaryPacketCodec();
  const symbolSize = 64;
  const symbolsPerBlock = 16; // 1024 bytes per block

  function generatePayload(size: number, seed: number = 777): Uint8Array {
    const buffer = new Uint8Array(size);
    let s = seed >>> 0;
    for (let i = 0; i < size; i++) {
      s = (s + 0x6d2b79f5) >>> 0;
      buffer[i] = (s ^ (s >>> 15)) & 0xff;
    }
    return buffer;
  }

  it('1. Quick Send: performs authenticated encrypted transfer with 10% loss and 5% duplication', () => {
    const originalData = generatePayload(2500, 101); // 3 blocks
    const originalHash = computeSha256(originalData);

    const blocker = new FileBlocker({ symbolSize, symbolsPerBlock });
    const { manifest, blocks } = blocker.partition(originalData, 'quick-transfer.bin');

    const senderIdentity = {
      deviceId: 'sender-device-01',
      keyPair: crypto.generateKeyPair(),
    };

    // 1. Sender initializes Quick Send
    const sender = new SenderSession(manifest, blocks, 'quick', senderIdentity, crypto);
    const announcement = sender.getAnnouncement();

    // 2. Receiver joins Quick Send (open-access handshake)
    const receiver = ReceiverSession.createQuickSend(announcement, undefined, crypto);
    const authReq = receiver.createAuthRequest();
    const authRes = sender.handleAuthRequest(authReq);
    expect(authRes.state).toBe('authorized');
    expect(authRes.keyEnvelope).toBeDefined();
    receiver.applyKeyEnvelope(authRes.keyEnvelope!);

    // 3. Sender generates encrypted packets
    const encryptedPackets = [];
    const overheadRatio = 2.4;
    for (const block of blocks) {
      const count = Math.ceil(block.k * overheadRatio);
      for (let s = 0; s < count; s++) {
        const pkt = sender.generateEncryptedPacket(block.blockIndex, s);
        // Serialize and deserialize to verify binary wire format with encrypted payloads
        const wireBytes = codec.encode(pkt);
        encryptedPackets.push(codec.decode(wireBytes));
      }
    }

    // 4. Channel simulation with loss and duplicates
    const channel = new SimulatedChannel({
      lossRate: 0.1,
      duplicationRate: 0.05,
      reorderRate: 0.1,
      seed: 8888,
    });
    const deliveredPackets = channel.transmitBatch(encryptedPackets);

    // 5. Receiver processes packets
    for (const pkt of deliveredPackets) {
      receiver.processPacket(pkt);
      if (receiver.isComplete()) {
        break;
      }
    }

    expect(receiver.isComplete()).toBe(true);
    const result = receiver.reassemble();
    expect(result.success).toBe(true);
    expect(result.fileBytes).toEqual(originalData);
    expect(result.sha256Digest).toBe(originalHash);
  });

  it('2. Private Send: performs authorization handshake, key encapsulation, and encrypted transfer', () => {
    const originalData = generatePayload(3200, 202); // 4 blocks
    const originalHash = computeSha256(originalData);

    const blocker = new FileBlocker({ symbolSize, symbolsPerBlock });
    const { manifest, blocks } = blocker.partition(originalData, 'confidential.pdf');

    const senderIdentity = {
      deviceId: 'sender-alice',
      keyPair: crypto.generateKeyPair(),
    };
    const bobIdentity = {
      deviceId: 'receiver-bob',
      keyPair: crypto.generateKeyPair(),
    };

    // 1. Sender starts Private Send
    const sender = new SenderSession(manifest, blocks, 'private', senderIdentity, crypto);
    const announcement = sender.getAnnouncement();

    // 2. Bob joins as prospective receiver
    const receiverBob = ReceiverSession.createPrivateSend(announcement, bobIdentity, crypto);
    expect(receiverBob.currentState).toBe('authorizing');

    // 3. Handshake: Bob requests access -> Alice approves
    const authReq = receiverBob.createAuthRequest();
    const pendingRes = sender.handleAuthRequest(authReq);
    expect(pendingRes.state).toBe('pending');
    expect(pendingRes.keyEnvelope).toBeUndefined();

    const approvalRes = sender.approveReceiver('receiver-bob');
    expect(approvalRes.state).toBe('authorized');
    expect(approvalRes.keyEnvelope).toBeDefined();

    // 4. Bob applies approved key envelope
    receiverBob.applyKeyEnvelope(approvalRes.keyEnvelope!);
    expect(receiverBob.currentState).toBe('receiving');

    // 5. Generate and transmit encrypted stream
    const packets = [];
    for (const block of blocks) {
      const count = Math.ceil(block.k * 2.6);
      for (let s = 0; s < count; s++) {
        const pkt = sender.generateEncryptedPacket(block.blockIndex, s);
        packets.push(pkt);
      }
    }

    const channel = new SimulatedChannel({
      lossRate: 0.05,
      duplicationRate: 0.1,
      reorderRate: 0.2,
      seed: 9999,
    });
    const delivered = channel.transmitBatch(packets);

    for (const p of delivered) {
      receiverBob.processPacket(p);
      if (receiverBob.isComplete()) {
        break;
      }
    }

    expect(receiverBob.isComplete()).toBe(true);
    const result = receiverBob.reassemble();
    expect(result.fileBytes).toEqual(originalData);
    expect(result.sha256Digest).toBe(originalHash);
  });

  it('3. Active Attacker: detects and rejects corrupted ciphertext payloads via AEAD tag validation', () => {
    const originalData = generatePayload(1024, 303);
    const blocker = new FileBlocker({ symbolSize, symbolsPerBlock });
    const { manifest, blocks } = blocker.partition(originalData, 'test.bin');

    const sender = new SenderSession(
      manifest,
      blocks,
      'quick',
      { deviceId: 'alice', keyPair: crypto.generateKeyPair() },
      crypto,
    );
    const receiver = ReceiverSession.createQuickSend(sender.getAnnouncement(), undefined, crypto);
    const authRes = sender.handleAuthRequest(receiver.createAuthRequest());
    receiver.applyKeyEnvelope(authRes.keyEnvelope!);

    const validPacket = sender.generateEncryptedPacket(0, 0);

    // Active attacker flips a bit in the ciphertext payload
    const tamperedPayload = new Uint8Array(validPacket.payload);
    tamperedPayload[tamperedPayload.length - 1]! ^= 0x01; // Tamper payload

    const corruptedPacket = {
      ...validPacket,
      payload: tamperedPayload,
    };

    // Receiver must reject with DecryptionError
    expect(() => receiver.processPacket(corruptedPacket)).toThrow(DecryptionError);
  });

  it('4. Rogue Receiver: unauthorized receiver cannot decrypt Private Send transmissions', () => {
    const originalData = generatePayload(1024, 404);
    const blocker = new FileBlocker({ symbolSize, symbolsPerBlock });
    const { manifest, blocks } = blocker.partition(originalData, 'secret.bin');

    const sender = new SenderSession(
      manifest,
      blocks,
      'private',
      { deviceId: 'alice', keyPair: crypto.generateKeyPair() },
      crypto,
    );
    const eveIdentity = {
      deviceId: 'eve-rogue',
      keyPair: crypto.generateKeyPair(),
    };

    // Eve joins Private Send without receiving Alice's approval
    const receiverEve = ReceiverSession.createPrivateSend(
      sender.getAnnouncement(),
      eveIdentity,
      crypto,
    );

    const packet = sender.generateEncryptedPacket(0, 0);

    // Attempting to process packet without approved key envelope throws Error
    expect(() => receiverEve.processPacket(packet)).toThrow(
      /Session security context not established/,
    );
  });

  it('5. Session Isolation: packets from Session A are rejected if injected into Session B', () => {
    const blocker = new FileBlocker({ symbolSize, symbolsPerBlock });
    const data = generatePayload(1024, 505);

    const partA = blocker.partition(data, 'session-A.bin');
    const partB = blocker.partition(data, 'session-B.bin');

    const senderA = new SenderSession(
      partA.manifest,
      partA.blocks,
      'quick',
      { deviceId: 'alice', keyPair: crypto.generateKeyPair() },
      crypto,
    );
    const senderB = new SenderSession(
      partB.manifest,
      partB.blocks,
      'quick',
      { deviceId: 'bob', keyPair: crypto.generateKeyPair() },
      crypto,
    );

    const receiverB = ReceiverSession.createQuickSend(senderB.getAnnouncement(), undefined, crypto);
    const authRes = senderB.handleAuthRequest(receiverB.createAuthRequest());
    receiverB.applyKeyEnvelope(authRes.keyEnvelope!);

    // Packet from Session A
    const packetFromA = senderA.generateEncryptedPacket(0, 1);

    // Injected into Session B receiver: fails AAD session binding / tag check
    expect(() => receiverB.processPacket(packetFromA)).toThrow(DecryptionError);
  });

  it('6. Multi-Receiver Quick Send Broadcast: single encrypted stream decoded by multiple receivers', () => {
    const originalData = generatePayload(2048, 606); // 2 blocks
    const originalHash = computeSha256(originalData);

    const blocker = new FileBlocker({ symbolSize, symbolsPerBlock });
    const { manifest, blocks } = blocker.partition(originalData, 'broadcast.bin');

    const sender = new SenderSession(
      manifest,
      blocks,
      'quick',
      { deviceId: 'broadcaster', keyPair: crypto.generateKeyPair() },
      crypto,
    );
    const announcement = sender.getAnnouncement();

    // Two independent receivers join the broadcast
    const receiver1 = ReceiverSession.createQuickSend(announcement, undefined, crypto);
    const res1 = sender.handleAuthRequest(receiver1.createAuthRequest());
    receiver1.applyKeyEnvelope(res1.keyEnvelope!);

    const receiver2 = ReceiverSession.createQuickSend(announcement, undefined, crypto);
    const res2 = sender.handleAuthRequest(receiver2.createAuthRequest());
    receiver2.applyKeyEnvelope(res2.keyEnvelope!);

    // Sender generates a SINGLE stream of encrypted packets
    const stream = [];
    for (const block of blocks) {
      const count = Math.ceil(block.k * 2.2);
      for (let s = 0; s < count; s++) {
        stream.push(sender.generateEncryptedPacket(block.blockIndex, s));
      }
    }

    // Both receivers process the exact same broadcast stream
    for (const pkt of stream) {
      if (!receiver1.isComplete()) receiver1.processPacket(pkt);
      if (!receiver2.isComplete()) receiver2.processPacket(pkt);
    }

    expect(receiver1.isComplete()).toBe(true);
    expect(receiver2.isComplete()).toBe(true);

    const result1 = receiver1.reassemble();
    const result2 = receiver2.reassemble();

    expect(result1.fileBytes).toEqual(originalData);
    expect(result2.fileBytes).toEqual(originalData);
    expect(result1.sha256Digest).toBe(originalHash);
    expect(result2.sha256Digest).toBe(originalHash);
  });

  it('7. Passive Observer Protection: eavesdropper without key agreement cannot decrypt stream', () => {
    const originalData = generatePayload(1024, 707);
    const blocker = new FileBlocker({ symbolSize, symbolsPerBlock });
    const { manifest, blocks } = blocker.partition(originalData, 'broadcast-secure.bin');

    const sender = new SenderSession(
      manifest,
      blocks,
      'quick',
      { deviceId: 'sender', keyPair: crypto.generateKeyPair() },
      crypto,
    );

    // Passive eavesdropper only captures announcement & broadcast packet
    const legitimateReceiver = ReceiverSession.createQuickSend(
      sender.getAnnouncement(),
      undefined,
      crypto,
    );
    const legAuthRes = sender.handleAuthRequest(legitimateReceiver.createAuthRequest());

    const packet = sender.generateEncryptedPacket(0, 0);

    // 1. Eavesdropper with their own keypair intercepts legitimate receiver's envelope and fails to unwrap it
    const eavesdropperKey = crypto.generateKeyPair();
    expect(() =>
      AuthorizationManager.unwrapKeyEnvelope(
        legAuthRes.keyEnvelope!,
        eavesdropperKey.privateKey,
        manifest.sessionId,
        crypto,
      ),
    ).toThrow(DecryptionError);

    // 2. Unauthenticated eavesdropper session cannot decrypt the broadcast stream
    const eavesdropperSession = ReceiverSession.createQuickSend(
      sender.getAnnouncement(),
      { deviceId: 'eavesdropper', keyPair: eavesdropperKey },
      crypto,
    );
    expect(() => eavesdropperSession.processPacket(packet)).toThrow(
      /Session security context not established/,
    );
  });

  it('8. Late Joining: receiver joining mid-stream requests envelope and successfully decodes', () => {
    const originalData = generatePayload(2048, 808);
    const blocker = new FileBlocker({ symbolSize, symbolsPerBlock });
    const { manifest, blocks } = blocker.partition(originalData, 'late-join.bin');

    const sender = new SenderSession(
      manifest,
      blocks,
      'quick',
      { deviceId: 'sender', keyPair: crypto.generateKeyPair() },
      crypto,
    );

    // Sender generates 15 packets before late receiver arrives
    const stream = [];
    for (const block of blocks) {
      const count = Math.ceil(block.k * 2.5);
      for (let s = 0; s < count; s++) {
        stream.push(sender.generateEncryptedPacket(block.blockIndex, s));
      }
    }

    // Receiver arrives late, handshakes for key envelope
    const lateReceiver = ReceiverSession.createQuickSend(
      sender.getAnnouncement(),
      undefined,
      crypto,
    );
    const authRes = sender.handleAuthRequest(lateReceiver.createAuthRequest());
    lateReceiver.applyKeyEnvelope(authRes.keyEnvelope!);

    // Late receiver receives packets starting from index 8 onwards (missed first 8)
    const missedPackets = stream.slice(8);
    for (const pkt of missedPackets) {
      lateReceiver.processPacket(pkt);
      if (lateReceiver.isComplete()) break;
    }

    expect(lateReceiver.isComplete()).toBe(true);
    const result = lateReceiver.reassemble();
    expect(result.fileBytes).toEqual(originalData);
  });
});

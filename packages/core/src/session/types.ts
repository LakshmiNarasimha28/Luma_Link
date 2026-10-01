/**
 * Session management boundaries, announcement messages, and lifecycle types for LumaLink.
 */

import type { FecScheme } from '../fec/types.js';
import type { SecurityMode } from '../security/types.js';

export type SessionRole = 'sender' | 'receiver';

export type SessionState =
  | 'idle'
  | 'announcing'
  | 'authorizing'
  | 'transmitting'
  | 'receiving'
  | 'completed'
  | 'failed'
  | 'aborted';

export interface SessionAnnouncement {
  readonly sessionId: string;
  readonly mode: SecurityMode;
  readonly senderDeviceId: string;
  readonly senderPublicKey: Uint8Array;
  readonly fileName: string;
  readonly fileSize: number;
  readonly sha256Digest: string;
  readonly symbolSize: number;
  readonly symbolsPerBlock: number;
  readonly totalBlocks: number;
  readonly timestamp: number;
}

export interface SessionConfig {
  readonly sessionId: string;
  readonly role: SessionRole;
  readonly mode: SecurityMode;
  readonly fecScheme: FecScheme;
}

export interface SessionStatus {
  readonly sessionId: string;
  readonly role: SessionRole;
  readonly state: SessionState;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly error?: string;
}

export interface SessionManager {
  readonly status: SessionStatus;
  start(): Promise<void>;
  abort(reason: string): Promise<void>;
}

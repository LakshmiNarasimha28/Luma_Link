/**
 * Session management boundaries and lifecycle types for LumaLink.
 */

import type { TransferMode } from '../protocol/types.js';
import type { FecScheme } from '../fec/types.js';

export type SessionRole = 'sender' | 'receiver';

export type SessionState =
  'idle' | 'negotiating' | 'transmitting' | 'receiving' | 'completed' | 'failed';

export interface SessionConfig {
  readonly sessionId: string;
  readonly role: SessionRole;
  readonly mode: TransferMode;
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

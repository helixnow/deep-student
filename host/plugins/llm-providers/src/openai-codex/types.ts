import { rustTrim } from '../../../../platform/util/portable.ts';
import type { CodexAuthStatus } from '../../../../../contracts/ipc/generated/L01-llm-providers.ts';

/** Host state keeps i64 exact; only the auth_status command converts to the IPC DTO. */
export type CodexAuthState = Omit<CodexAuthStatus, 'expiresAtUnixMs'> & { expiresAtUnixMs: bigint | null };

export const SESSION_SCHEMA_VERSION = 1;
/** The registered symbol Node's `util.inspect` consults; other runtimes ignore it. */
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');
export interface StoredSessionData {
  schemaVersion: number;
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  expiresAtUnixMs: bigint;
  accountId: string;
  email: string | null;
  planType: string | null;
  isFedramp: boolean;
  lastRefreshAt: bigint | null;
}
export class StoredCodexSession implements StoredSessionData {
  schemaVersion: number;
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  expiresAtUnixMs: bigint;
  accountId: string;
  email: string | null;
  planType: string | null;
  isFedramp: boolean;
  lastRefreshAt: bigint | null;
  constructor(data: StoredSessionData) {
    this.schemaVersion = data.schemaVersion; this.accessToken = data.accessToken; this.refreshToken = data.refreshToken;
    this.idToken = data.idToken; this.expiresAtUnixMs = data.expiresAtUnixMs; this.accountId = data.accountId;
    this.email = data.email; this.planType = data.planType; this.isFedramp = data.isFedramp; this.lastRefreshAt = data.lastRefreshAt;
  }
  isValid(): boolean {
    return this.schemaVersion === SESSION_SCHEMA_VERSION && rustTrim(this.accessToken) !== ''
      && rustTrim(this.refreshToken) !== '' && rustTrim(this.accountId) !== '' && this.expiresAtUnixMs > 0n;
  }
  clone(): StoredCodexSession { return new StoredCodexSession(this); }
  [INSPECT_CUSTOM](): unknown {
    return { schemaVersion: this.schemaVersion, accessToken: '[REDACTED]', refreshToken: '[REDACTED]',
      idToken: this.idToken === null ? null : '[REDACTED]', expiresAtUnixMs: this.expiresAtUnixMs,
      accountId: redactAccountId(this.accountId), email: this.email, planType: this.planType,
      isFedramp: this.isFedramp, lastRefreshAt: this.lastRefreshAt };
  }
}
export class CodexRequestAuth {
  _accessToken: string;
  _accountId: string;
  _generation: number;
  _expiresAtUnixMs: bigint;
  _isFedramp: boolean;
  constructor(session: StoredSessionData, generation: number) {
    this._accessToken = session.accessToken; this._accountId = session.accountId; this._generation = generation;
    this._expiresAtUnixMs = session.expiresAtUnixMs; this._isFedramp = session.isFedramp;
  }
  accessToken(): string { return this._accessToken; }
  accountId(): string { return this._accountId; }
  generation(): number { return this._generation; }
  expiresAtUnixMs(): bigint { return this._expiresAtUnixMs; }
  isFedramp(): boolean { return this._isFedramp; }
  [INSPECT_CUSTOM](): unknown {
    return { accessToken: '[REDACTED]', accountId: redactAccountId(this._accountId), generation: this._generation,
      expiresAtUnixMs: this._expiresAtUnixMs, isFedramp: this._isFedramp };
  }
}
export function redactAccountId(accountId: string): string { return '***' + [...accountId].slice(-6).join(''); }
export interface BrowserLoginStart { attemptId: string; authorizationUrl: string; redirectUri: string; expiresAtUnixMs: number }
export interface DeviceLoginStart { attemptId: string; verificationUrl: string; userCode: string; expiresAtUnixMs: number; pollIntervalSeconds: number }

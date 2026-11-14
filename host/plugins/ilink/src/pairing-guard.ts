export const PAIR_TTL_MS = 10 * 60_000;
/** 配对码为 4 位（生成端 `getRandomValues(new Uint8Array(PAIR_CODE_LENGTH))`，校验端同长度）。 */
export const PAIR_CODE_LENGTH = 4;
/** 同一账户在 TTL 窗口内连续验证失败达到此数即锁定生成新码。 */
export const PAIR_MAX_FAILURES = 5;
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 从用户输入里抽出配对码（容忍 `/pair ` 前缀、空格与连字符），不合法时返回 null。 */
export function extractIlinkPairingCode(input: string): string | null {
  const code = input.trim().replace(/^\/pair\s+/i, '').replace(/[\s-]/g, '').toUpperCase();
  return new RegExp(`^[A-Z0-9]{${PAIR_CODE_LENGTH}}$`).test(code) ? code : null;
}

export function normalizeIlinkPairingCode(input: string): string | null {
  return extractIlinkPairingCode(input);
}

export interface IlinkPairingGuardOptions {
  now?: () => number;
  ttlMs?: number;
  /** For deterministic tests; production uses Web Crypto. */
  generateCode?: () => string;
}

export type IlinkPairingResult =
  | { ok: true; boundUserId: string }
  | { ok: false; reason: 'invalid_code' | 'expired' | 'no_code' | 'cooldown' };

type PairingAccount = {
  code: string | null;
  expiresAt: number;
  failures: number[];
  cooldownUntil: number;
  boundUserId: string | null;
};

/** Account-scoped, synchronous consumption/revocation. Persist externally if needed. */
export class IlinkPairingGuard {
  private readonly accounts = new Map<string, PairingAccount>();
  private readonly now: () => number;
  private readonly options: IlinkPairingGuardOptions;

  constructor(options: IlinkPairingGuardOptions = {}) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  private account(accountId: string): PairingAccount {
    let account = this.accounts.get(accountId);
    if (!account) {
      account = { code: null, expiresAt: 0, failures: [], cooldownUntil: 0, boundUserId: null };
      this.accounts.set(accountId, account);
    }
    return account;
  }

  generate(accountId: string): { code: string; expiresAt: number } {
    const account = this.account(accountId), now = this.now();
    if (account.cooldownUntil > now) throw new Error('pairing_cooldown');
    const raw = this.options.generateCode?.() ?? Array.from(globalThis.crypto.getRandomValues(new Uint8Array(PAIR_CODE_LENGTH)), value => PAIR_ALPHABET[value % PAIR_ALPHABET.length]).join('');
    const code = normalizeIlinkPairingCode(raw);
    if (!code) throw new Error('invalid_pairing_code');
    account.code = code;
    account.expiresAt = now + (this.options.ttlMs ?? PAIR_TTL_MS);
    return { code, expiresAt: account.expiresAt };
  }

  verify(accountId: string, input: string, userId: string): IlinkPairingResult {
    const account = this.account(accountId), now = this.now();
    if (account.cooldownUntil > now) return { ok: false, reason: 'cooldown' };
    if (!account.code) return { ok: false, reason: 'no_code' };
    if (now >= account.expiresAt) {
      account.code = null;
      return { ok: false, reason: 'expired' };
    }
    if (!userId || normalizeIlinkPairingCode(input) !== account.code) {
      account.failures = account.failures.filter(time => time > now - PAIR_TTL_MS);
      account.failures.push(now);
      if (account.failures.length >= PAIR_MAX_FAILURES) {
        account.code = null;
        account.cooldownUntil = now + PAIR_TTL_MS;
        return { ok: false, reason: 'cooldown' };
      }
      return { ok: false, reason: 'invalid_code' };
    }
    account.code = null;
    account.boundUserId = userId;
    return { ok: true, boundUserId: userId };
  }

  boundUserId(accountId: string): string | null {
    return this.accounts.get(accountId)?.boundUserId ?? null;
  }

  revoke(accountId: string): void {
    const account = this.account(accountId);
    account.code = null;
    account.expiresAt = 0;
    account.boundUserId = null;
    // Never clear brute-force accounting by revoking or regenerating a code.
  }
}

export interface IlinkChannelReadinessInput {
  connected: boolean;
  boundUserId: string | null;
  botEnabled: boolean;
  modelConfigured: boolean;
  loginRequired?: boolean;
  lastError?: string | null;
}

export type IlinkChannelReadinessStage = 'login_required' | 'waiting_connection' | 'connected_unbound' | 'bot_disabled' | 'model_unconfigured' | 'needs_attention' | 'ready';

export function evaluateChannelReadiness(input: IlinkChannelReadinessInput): {
  stage: IlinkChannelReadinessStage;
  checklist: { connected: boolean; bound: boolean; botEnabled: boolean; modelConfigured: boolean };
} {
  const checklist = { connected: input.connected && !input.loginRequired, bound: Boolean(input.boundUserId), botEnabled: input.botEnabled, modelConfigured: input.modelConfigured };
  const stage = input.loginRequired ? 'login_required' : !checklist.connected ? 'waiting_connection'
    : !checklist.bound ? 'connected_unbound' : !checklist.botEnabled ? 'bot_disabled'
      : !checklist.modelConfigured ? 'model_unconfigured' : input.lastError ? 'needs_attention' : 'ready';
  return { stage, checklist };
}

// 对外别名：`host/plugins/ilink/api.ts` 以不带 `Ilink` 前缀的名字再导出这几项。
export type IlinkPairingVerifyResult = IlinkPairingResult;
export type ChannelReadinessInput = IlinkChannelReadinessInput;
export type ChannelReadinessStage = IlinkChannelReadinessStage;
export type ChannelReadinessReport = ReturnType<typeof evaluateChannelReadiness>;

import { describe, expect, it } from 'vitest';
import { commitSwitch, decide, isQuotaError, normalizeState } from './lib/accounts.mjs';

const cfg = { integration: 'OpenCode Console', accounts: ['A', 'B', 'C'], cooldownMinutes: 10, quotaWindowMinutes: 300 };
const T0 = Date.parse('2026-11-04T00:00:00Z');
const min = 60_000;

describe('quota error detection', () => {
  it('treats 429/402 and explicit quota wording as quota errors', () => {
    expect(isQuotaError({ status: 429 })).toBe(true);
    expect(isQuotaError({ status: 402 })).toBe(true);
    expect(isQuotaError({ message: 'You have reached your 5-hour usage limit' })).toBe(true);
    expect(isQuotaError({ message: '额度已用尽' })).toBe(true);
  });
  it('does not mistake context overflow or generic errors for quota exhaustion', () => {
    expect(isQuotaError({ message: 'maximum context length exceeded' })).toBe(false);
    expect(isQuotaError({ message: 'ECONNRESET: socket closed' })).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
  });
});

describe('account scheduling', () => {
  it('migrates the legacy index state to the active account name', () => {
    expect(normalizeState({ index: 1, lastSwitchAt: null }, cfg)).toMatchObject({ active: 'B', exhausted: {} });
  });

  it('switches to the next account that is not exhausted, skipping exhausted ones', () => {
    const s = normalizeState({ active: 'A', exhausted: { B: new Date(T0 - 60 * min).toISOString() } }, cfg);
    expect(decide(s, cfg, T0, { quotaHit: true })).toEqual({ action: 'switch', to: 'C' });
    expect(s.exhausted.A).toBe(new Date(T0).toISOString());
  });

  it('stays put when every account is exhausted and reports the earliest recovery', () => {
    const s = normalizeState({ active: 'A', exhausted: { B: new Date(T0 - 100 * min).toISOString(), C: new Date(T0 - 200 * min).toISOString() } }, cfg);
    const r = decide(s, cfg, T0, { quotaHit: true });
    expect(r).toMatchObject({ action: 'stay', reason: '全部账号额度耗尽' });
    expect(r.nextAvailableAt).toBe(T0 - 200 * min + 300 * min);
  });

  it('proactively moves off an exhausted account once another recovers, without a new failure', () => {
    const s = normalizeState({ active: 'A', exhausted: { A: new Date(T0).toISOString(), B: new Date(T0 - 250 * min).toISOString(), C: new Date(T0).toISOString() } }, cfg);
    expect(decide(s, cfg, T0 + 30 * min, { quotaHit: false })).toMatchObject({ action: 'stay', reason: '全部账号额度耗尽' });
    expect(decide(s, cfg, T0 + 60 * min, { quotaHit: false })).toEqual({ action: 'switch', to: 'B' });
  });

  it('honours the cooldown between switches and does nothing while the active account is healthy', () => {
    const s = normalizeState({ active: 'A' }, cfg);
    expect(decide(s, cfg, T0, { quotaHit: false })).toEqual({ action: 'stay', reason: '当前账号可用' });
    const r = decide(s, cfg, T0, { quotaHit: true });
    expect(r).toEqual({ action: 'switch', to: 'B' });
    commitSwitch(s, 'B', T0);
    expect(decide(s, cfg, T0 + 5 * min, { quotaHit: true })).toEqual({ action: 'stay', reason: '冷却中' });
    expect(decide(s, cfg, T0 + 11 * min, { quotaHit: false })).toEqual({ action: 'switch', to: 'C' });
  });

  it('supports any number of accounts', () => {
    const many = { ...cfg, accounts: ['A', 'B', 'C', 'D', 'E'] };
    const s = normalizeState({ active: 'D', exhausted: { E: new Date(T0).toISOString(), A: new Date(T0).toISOString() } }, many);
    expect(decide(s, many, T0, { quotaHit: true })).toEqual({ action: 'switch', to: 'B' });
  });
});

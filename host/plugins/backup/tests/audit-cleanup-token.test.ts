/**
 * WP-148：`data_governance_cleanup_audit_logs` 令牌时间戳按 Rust `i64::from_str` 解析
 * （`src-tauri/src/data_governance/commands.rs:606-623`）。
 *
 * 全部经 `host.invoke` 真实入口与隔离临时库；无效/过期令牌在打开审计库之前返回，
 * 命令期间不得调用 `storage.database('audit')`，审计表行不变。
 */
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { Connection } from '../../../platform/storage/connection.ts';
import { PROFILES } from '../../../platform/storage/profiles.ts';
import { createBackupHost, createRealStorage } from './helpers.ts';

const hosts: TestHost[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) await host.dispose();
});

const INVALID = '审计清理令牌中的时间戳无效';
const I64_MAX = 9223372036854775807n;
const FIXED_NOW_SECS = 1_762_400_000;

interface Env {
  host: TestHost;
  auditPath: string;
  /** 安装完成后 `storage.database('audit')` 的调用次数。 */
  auditOpens: () => number;
}

async function setup(): Promise<Env> {
  let opens = 0;
  let counting = false;
  const created = await createBackupHost({
    storageFactory: (dataDir, activeDir) => {
      const storage = createRealStorage(activeDir, dataDir);
      const database = storage.database as (name: string) => unknown;
      storage.database = (name: string) => {
        if (counting && name === 'audit') opens += 1;
        return database(name);
      };
      return storage;
    },
  });
  hosts.push(created.host);
  counting = true;
  return {
    host: created.host,
    auditPath: join(created.host.app.dataDir, 'slots', 'slotA', 'databases', 'audit.db'),
    auditOpens: () => opens,
  };
}

function fixNow(): void {
  vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW_SECS * 1000 + 999);
}

function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => { throw new Error('expected rejection'); }, error => error);
}

function expired(diff: bigint | number): string {
  return `审计清理令牌已过期（差值 ${diff}s，允许 60s 内）`;
}

function auditRows(path: string): Array<{ target: string; details: string | null }> {
  const conn = new Connection(path, { label: 'audit.db', profile: PROFILES.plain, mustExist: true });
  try {
    return conn.all('SELECT target, details FROM __audit_log ORDER BY rowid ASC') as never;
  } finally {
    conn.close();
  }
}

function auditSnapshot(path: string): unknown[] {
  const conn = new Connection(path, { label: 'audit.db', profile: PROFILES.plain, mustExist: true });
  try {
    return conn.all('SELECT * FROM __audit_log ORDER BY rowid ASC') as unknown[];
  } finally {
    conn.close();
  }
}

it('cleanup_audit_logs token: non-i64 text is rejected as invalid before touching the audit db', async () => {
  const { host, auditPath, auditOpens } = await setup();
  fixNow();
  const before = auditSnapshot(auditPath);
  const vectors = [
    '', '+', '-', '+-1', '-+1', '++1', '--1', ' 0', '0 ', '\t0', '0\n', 'abc', '1.5', '1e3',
    '0x10', '１２３', '\u0661', '1_000', '9223372036854775808', '+9223372036854775808',
    '-9223372036854775809', '99999999999999999999999',
  ];
  for (const text of vectors) {
    const rejection = await rejectionOf(host.invoke('data_governance_cleanup_audit_logs', {
      keepRecent: 1,
      beforeDays: 1,
      confirmationToken: `AUDIT_CLEANUP_${text}`,
    }));
    expect({ text, rejection }).toEqual({ text, rejection: INVALID });
  }
  expect(auditOpens()).toBe(0);
  expect(auditSnapshot(auditPath)).toEqual(before);
});

it('cleanup_audit_logs token: i64 text with sign / leading zeros reaches the exact expiry diff', async () => {
  const { host, auditPath, auditOpens } = await setup();
  fixNow();
  const before = auditSnapshot(auditPath);
  const now = BigInt(FIXED_NOW_SECS);
  const vectors: Array<[string, bigint]> = [
    ['0', now],
    ['+0', now],
    ['-0', now],
    ['0000000000', now],
    ['-1', now + 1n],
    ['+1', now - 1n],
    ['9223372036854775807', I64_MAX - now],
    ['+9223372036854775807', I64_MAX - now],
    ['000009223372036854775807', I64_MAX - now],
    ['9007199254740993', 9007199254740993n - now],
    [`${FIXED_NOW_SECS + 61}`, 61n],
    [`-0${FIXED_NOW_SECS}`, 2n * now],
  ];
  for (const [text, diff] of vectors) {
    const rejection = await rejectionOf(host.invoke('data_governance_cleanup_audit_logs', {
      keepRecent: 1,
      beforeDays: 1,
      confirmationToken: `AUDIT_CLEANUP_${text}`,
    }));
    expect({ text, rejection }).toEqual({ text, rejection: expired(diff) });
  }
  expect(auditOpens()).toBe(0);
  expect(auditSnapshot(auditPath)).toEqual(before);
});

it('cleanup_audit_logs token: +/leading-zero current token keeps the threshold and success semantics', async () => {
  const { host, auditPath, auditOpens } = await setup();
  fixNow();
  const before = auditSnapshot(auditPath);
  const below = await rejectionOf(host.invoke('data_governance_cleanup_audit_logs', {
    keepRecent: 99,
    confirmationToken: `AUDIT_CLEANUP_+${FIXED_NOW_SECS}`,
  }));
  expect(below).toBe('keep_recent 不得低于 100，当前值: 99');
  expect(auditOpens()).toBe(0);
  expect(auditSnapshot(auditPath)).toEqual(before);

  for (const text of [`+${FIXED_NOW_SECS}`, `00${FIXED_NOW_SECS - 60}`, `+${FIXED_NOW_SECS + 60}`]) {
    await expect(host.invoke('data_governance_cleanup_audit_logs', {
      keepRecent: 100,
      confirmationToken: `AUDIT_CLEANUP_${text}`,
    })).resolves.toBe(0);
  }
  expect(auditOpens()).toBeGreaterThan(0);
  const rows = auditRows(auditPath).slice(before.length);
  expect(rows.map(row => row.target)).toEqual([
    'cleanup_audit_logs_initiated', 'cleanup_audit_logs',
    'cleanup_audit_logs_initiated', 'cleanup_audit_logs',
    'cleanup_audit_logs_initiated', 'cleanup_audit_logs',
  ]);
  expect(rows.filter(row => row.target === 'cleanup_audit_logs_initiated')
    .map(row => JSON.parse(row.details ?? 'null').confirmation_token_ts))
    .toEqual([FIXED_NOW_SECS, FIXED_NOW_SECS - 60, FIXED_NOW_SECS + 60]);
});

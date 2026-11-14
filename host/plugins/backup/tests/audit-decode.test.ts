/**
 * v2 §1.3 自查：`data_governance_get_audit_logs` 按 Rust serde / chrono 解码审计行。
 * Rust：dstu-storage `audit/mod.rs:43-90,767-807,352-360`；commands_types.rs:61-80。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { defineQuery, type SqlExecutor } from '../../../platform/storage/api.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import type {} from '../api.ts';
import { initAuditTable, queryAuditLogs, saveAuditLog } from '../repository/audit.ts';
import { createBackupHost } from './helpers.ts';

const hosts: TestHost[] = [];
const json = JSON as typeof JSON & { rawJSON(text: string): unknown };
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
});

async function setupAudit(): Promise<{ host: TestHost; audit: SqlExecutor }> {
  let storage!: StorageServiceImpl;
  const created = await createBackupHost({
    storageFactory: dataDir => {
      storage = createStorageService({ baseDir: dataDir, dataLocalDir: dataDir });
      return storage;
    },
  });
  hosts.push(created.host);
  created.host.ctx.effect(() => () => storage.dispose());
  mkdirSync(join(storage.locations.activeDir, 'databases'), { recursive: true });
  const audit = storage.database('audit');
  initAuditTable(audit);
  return { host: created.host, audit };
}

function insert(audit: SqlExecutor, id: string, timestamp: string, operation: string): void {
  audit.run(
    `INSERT INTO __audit_log (id, timestamp, operation_type, operation_data, target, status, duration_ms, details, error_message)
     VALUES (?1, ?2, 'Backup', ?3, 'target', 'Completed', 5, NULL, NULL)`,
    [id, timestamp, operation],
  );
}

function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => { throw new Error('expected rejection'); }, error => error);
}

it('get_audit_logs keeps nanosecond timestamps and re-renders them with to_rfc3339', async () => {
  const { host, audit } = await setupAudit();
  insert(audit, 'a1', '2026-01-02T03:04:05.123456789Z',
    JSON.stringify({ type: 'Backup', backup_type: 'Full', file_count: 3, total_size: 10 }));

  const result = await host.invoke('data_governance_get_audit_logs', {}) as {
    logs: Array<{ id: string; timestamp: string; operation_type: string }>;
    total: number;
  };
  expect(result.total).toBe(1);
  expect(result.logs[0]!.timestamp).toBe('2026-01-02T03:04:05.123456789+00:00');
  expect(result.logs[0]!.operation_type).toBe('Backup');
});

it.each([
  ['{"backup_type":"Full","file_count":1,"total_size":1}', 'missing field `type`'],
  ['{"type":"Unknown"}', 'unknown variant `Unknown`'],
  ['{"type":"Backup","backup_type":"Delta","file_count":1,"total_size":1}', 'unknown variant `Delta`'],
  ['{"type":"Backup","backup_type":"Full","file_count":-1,"total_size":1}', 'invalid value: integer `-1`, expected usize'],
  ['{"type":"Restore"}', 'missing field `backup_path`'],
  ['not json', 'Serialization error:'],
])('get_audit_logs fails the query on undecodable operation_data %s', async (operation, message) => {
  const { host, audit } = await setupAudit();
  insert(audit, 'bad', '2026-01-02T03:04:05Z', operation);

  const rejection = await rejectionOf(host.invoke('data_governance_get_audit_logs', {}));
  expect(typeof rejection).toBe('string');
  expect(rejection as string).toMatch(/^查询审计日志失败: Serialization error: /);
  expect(rejection as string).toContain(message);
});

it('get_audit_logs rejects a non-RFC3339 timestamp as a database error', async () => {
  const { host, audit } = await setupAudit();
  insert(audit, 'bad-ts', '2026/01/02 03:04:05',
    JSON.stringify({ type: 'Maintenance', action: 'cleanup' }));

  const rejection = await rejectionOf(host.invoke('data_governance_get_audit_logs', {}));
  expect(rejection).toBe('查询审计日志失败: Database error: Invalid timestamp: 2026/01/02 03:04:05');
});

it.each([
  ['u64 overflow', '{"type":"Backup","backup_type":"Full","file_count":1,"total_size":18446744073709551616}', 'expected u64'],
  ['usize overflow', '{"type":"Backup","backup_type":"Full","file_count":18446744073709551616,"total_size":1}', 'expected usize'],
  ['decimal integer', '{"type":"Backup","backup_type":"Full","file_count":1.0,"total_size":1}', 'expected usize'],
  ['exponent integer', '{"type":"Backup","backup_type":"Full","file_count":1,"total_size":1e0}', 'expected u64'],
  ['negative zero', '{"type":"Backup","backup_type":"Full","file_count":-0,"total_size":1}', 'expected usize'],
  ['u32 overflow', '{"type":"Migration","from_version":4294967296,"to_version":1,"applied_count":1}', 'expected u32'],
  ['duplicate count', '{"type":"Backup","backup_type":"Full","file_count":1,"file_count":2,"total_size":1}', 'duplicate field `file_count`'],
  ['duplicate tag', '{"type":"Maintenance","type":"Maintenance","action":"clean"}', 'duplicate field `type`'],
  ['non-unit enum payload', '{"type":"Backup","backup_type":{"Full":false},"file_count":1,"total_size":1}', 'expected unit'],
])('get_audit_logs rejects serde-invalid persisted numeric/tag input: %s', async (_label, operation, message) => {
  const { host, audit } = await setupAudit();
  insert(audit, 'invalid-serde', '2026-01-02T03:04:05Z', operation);
  const rejection = await rejectionOf(host.invoke('data_governance_get_audit_logs', {}));
  expect(typeof rejection).toBe('string');
  expect(rejection as string).toMatch(/^查询审计日志失败: Serialization error: /);
  expect(rejection as string).toContain(message);
});

it.each([
  ['Backup', '{"type":"Backup","backup_type":{"Full":null},"file_count":1,"total_size":1}'],
  ['Sync', '{"type":"Sync","direction":{"Upload":null},"records_affected":1}'],
])('get_audit_logs accepts the serde unit-enum map form in %s', async (kind, operation) => {
  const { host, audit } = await setupAudit();
  insert(audit, 'enum-map', '2026-01-02T03:04:05Z', operation);
  expect(await host.invoke('data_governance_get_audit_logs', {})).toMatchObject({
    total: 1, logs: [{ operation_type: kind }],
  });
});

it('get_audit_logs ignores unknown fields without rejecting repeated unknown keys', async () => {
  const { host, audit } = await setupAudit();
  insert(audit, 'unknown-fields', '2026-01-02T03:04:05Z',
    '{"extra":1,"type":"Maintenance","extra":2,"action":"clean"}');
  expect(await host.invoke('data_governance_get_audit_logs', {})).toMatchObject({
    total: 1, logs: [{ operation_type: 'Maintenance' }],
  });
});

it.each([
  ['Backup', '{"type":"Backup","backup_type":"Full","file_count":1,"total_size":18446744073709551615}', 'total_size'],
  ['Migration', '{"type":"Migration","from_version":0,"to_version":1,"applied_count":18446744073709551615}', 'applied_count'],
  ['Sync', '{"type":"Sync","direction":"Upload","records_affected":18446744073709551615}', 'records_affected'],
] as const)('get_audit_logs preserves the legal u64 maximum in %s internally and when saved again', async (kind, operation, field) => {
  const { host, audit } = await setupAudit();
  insert(audit, 'u64-max', '2026-01-02T03:04:05Z', operation);
  expect(await host.invoke('data_governance_get_audit_logs', {})).toMatchObject({
    total: 1, logs: [{ operation_type: kind }],
  });
  const decoded = queryAuditLogs(audit, {})[0]!;
  expect(decoded.operation).toHaveProperty(field, 18446744073709551615n);
  saveAuditLog(audit, { ...decoded, id: 'u64-resaved' });
  expect(audit.get<{ operation_data: string }>(
    'SELECT operation_data FROM __audit_log WHERE id = ?', ['u64-resaved'],
  )!.operation_data).toBe(operation);
});

it.each([
  ['negative integer', -1n, 'Integer -1 out of range at index 6'],
  ['real', 0.5, 'Invalid column type Real at index: 6, name: duration_ms'],
  ['text', 'bad-duration', 'Invalid column type Text at index: 6, name: duration_ms'],
  ['blob', new Uint8Array([53]), 'Invalid column type Blob at index: 6, name: duration_ms'],
] as const)('get_audit_logs rejects SQL duration as %s before returning a summary', async (_label, value, message) => {
  const { host, audit } = await setupAudit();
  insert(audit, 'sql-duration', '2026-01-02T03:04:05Z', '{"type":"Maintenance","action":"clean"}');
  audit.run('UPDATE __audit_log SET duration_ms = ? WHERE id = ?', [value, 'sql-duration']);
  expect(await rejectionOf(host.invoke('data_governance_get_audit_logs', {})))
    .toBe(`查询审计日志失败: Database error: ${message}`);
});

it('get_audit_logs checks SQL duration before timestamp and operation parsing', async () => {
  const { host, audit } = await setupAudit();
  insert(audit, 'sql-priority', 'invalid timestamp', 'not json');
  audit.run('UPDATE __audit_log SET duration_ms = -1 WHERE id = ?', ['sql-priority']);
  expect(await rejectionOf(host.invoke('data_governance_get_audit_logs', {})))
    .toBe('查询审计日志失败: Database error: Integer -1 out of range at index 6');
});

it('get_audit_logs preserves earlier SQL column errors before invalid duration', async () => {
  const { host, audit } = await setupAudit();
  insert(audit, 'sql-column-order', '2026-01-02T03:04:05Z', '{"type":"Maintenance","action":"clean"}');
  audit.run('UPDATE __audit_log SET operation_type = ?, duration_ms = -1 WHERE id = ?', [new Uint8Array([66]), 'sql-column-order']);
  expect(await rejectionOf(host.invoke('data_governance_get_audit_logs', {})))
    .toBe('查询审计日志失败: Database error: Invalid column type Blob at index: 2, name: operation_type');
});

it('get_audit_logs keeps a null SQL duration as None, not zero', async () => {
  const { host, audit } = await setupAudit();
  insert(audit, 'null-duration', '2026-01-02T03:04:05Z', '{"type":"Maintenance","action":"clean"}');
  audit.run('UPDATE __audit_log SET duration_ms = NULL WHERE id = ?', ['null-duration']);
  expect(await host.invoke('data_governance_get_audit_logs', {})).toMatchObject({
    logs: [{ duration_ms: null }],
  });
  expect(queryAuditLogs(audit, {})[0]!.duration_ms).toBeNull();
});

it('get_audit_logs keeps SQL duration exact internally and on re-save, rounding only the summary', async () => {
  const { host, audit } = await setupAudit();
  const maximum = 9223372036854775807n; // SQLite INTEGER最大值；Rust Option<u64>合法读取。
  insert(audit, 'wide-duration', '2026-01-02T03:04:05Z', '{"type":"Maintenance","action":"clean"}');
  audit.run('UPDATE __audit_log SET duration_ms = ? WHERE id = ?', [maximum, 'wide-duration']);
  // IPC按D3/Tauri前端JSON number舍入，但仓储中不得先丢失低位。
  expect(await host.invoke('data_governance_get_audit_logs', {})).toMatchObject({
    logs: [{ duration_ms: Number(maximum) }],
  });
  const decoded = queryAuditLogs(audit, {})[0]!;
  expect(decoded.duration_ms).toBe(maximum);
  saveAuditLog(audit, { ...decoded, id: 'duration-resaved' });
  const readDuration = defineQuery<readonly [string], { duration_ms: bigint }>(
    'SELECT duration_ms FROM __audit_log WHERE id = ?', { options: { safeIntegers: true } },
  );
  expect(audit.get(readDuration, ['duration-resaved'])!.duration_ms).toBe(maximum);
});

it.each([
  ['nested wide integers', '{"job_id":"wide-job","bytes":18446744073709551615,"nested":{"negative":-9223372036854775808,"safe":42}}',
    { job_id: 'wide-job', bytes: 18446744073709551615n, nested: { negative: -9223372036854775808n, safe: 42 } },
    '{"job_id":"wide-job","bytes":18446744073709551615,"nested":{"negative":-9223372036854775808,"safe":42}}'],
  ['root wide integer', '18446744073709551615', 18446744073709551615n, '18446744073709551615'],
  ['array wide integers', '[9007199254740993,{"count":9223372036854775807}]',
    [9007199254740993n, { count: 9223372036854775807n }], '[9007199254740993,{"count":9223372036854775807}]'],
  ['duplicate object key', '{"n":1,"n":2,"values":[null,true,"text",0.5]}',
    { n: 2, values: [null, true, 'text', json.rawJSON('0.5')] }, '{"n":2,"values":[null,true,"text",0.5]}'],
] as const)('get_audit_logs preserves serde Value details on query and re-save: %s', async (_label, text, expected, saved) => {
  const { host, audit } = await setupAudit();
  insert(audit, 'details-value', '2026-01-02T03:04:05Z', '{"type":"Maintenance","action":"clean"}');
  audit.run('UPDATE __audit_log SET details = ? WHERE id = ?', [text, 'details-value']);
  expect(await host.invoke('data_governance_get_audit_logs', {})).toMatchObject({ total: 1 });
  const decoded = queryAuditLogs(audit, {})[0]!;
  expect(decoded.details).toEqual(expected);
  saveAuditLog(audit, { ...decoded, id: 'details-resaved' });
  expect(audit.get<{ details: string }>('SELECT details FROM __audit_log WHERE id = ?', ['details-resaved'])!.details).toBe(saved);
});

it.each([
  ['non-JSON', 'not json'],
  ['SQL NULL', null],
  ['empty string', ''],
] as const)('get_audit_logs keeps best-effort serde details fallback for %s', async (_label, text) => {
  const { host, audit } = await setupAudit();
  insert(audit, 'invalid-details', '2026-01-02T03:04:05Z', '{"type":"Maintenance","action":"clean"}');
  audit.run('UPDATE __audit_log SET details = ? WHERE id = ?', [text, 'invalid-details']);
  expect(await host.invoke('data_governance_get_audit_logs', {})).toMatchObject({ total: 1 });
  expect(queryAuditLogs(audit, {})[0]!.details).toBeNull();
});

// 完成状态pending不等于禁用测试：旧F4 parser不支持时保留真实失败，交provider+consumer同树验证。
// F4 fd920f955已给jsonNumberToRawJSON合同；保持合法Value/精确数字断言，不加能力探测或本地lexer。
it.each([
  ['{"n":1e999}', '{"n":1e+999}'],
  ['[1e999,-1e999,{"n":1.23456789012345678901234567890123456789}]',
    '[1e+999,-1e+999,{"n":1.23456789012345678901234567890123456789}]'],
] as const)('get_audit_logs preserves arbitrary_precision details without Number projection: %s', async (text, saved) => {
  const { host, audit } = await setupAudit();
  insert(audit, 'arbitrary-details', '2026-01-02T03:04:05Z', '{"type":"Maintenance","action":"clean"}');
  audit.run('UPDATE __audit_log SET details = ? WHERE id = ?', [text, 'arbitrary-details']);
  expect(await host.invoke('data_governance_get_audit_logs', {})).toMatchObject({ total: 1 });
  const decoded = queryAuditLogs(audit, {})[0]!;
  expect(decoded.details).not.toBeNull();
  saveAuditLog(audit, { ...decoded, id: 'arbitrary-details-resaved' });
  expect(audit.get<{ details: string }>('SELECT details FROM __audit_log WHERE id = ?', ['arbitrary-details-resaved'])!.details).toBe(saved);
});

it('get_audit_logs rejects arbitrary Value numbers in typed AuditOperation integer fields', async () => {
  const { host, audit } = await setupAudit();
  insert(audit, 'arbitrary-operation', '2026-01-02T03:04:05Z',
    '{"type":"Backup","backup_type":"Full","file_count":1e999,"total_size":1}');
  const error = await rejectionOf(host.invoke('data_governance_get_audit_logs', {}));
  // 这里只证明合法Value数字不会放宽有界字段；内部tagged enum的精确诊断不能由typed readNumber单独推断。
  expect(error).toMatch(/^查询审计日志失败: Serialization error: /);
});

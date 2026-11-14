/**
 * G1：`llm_usage_session_summary({sessionId})` 经真实 kernel 命令，覆盖全新安装库与历史库升级。
 *
 * Rust `repo.rs:450-465` 声明“caller_id = session_id”，但 SQL 写成 `WHERE caller_id = ?1`；
 * llm_usage 的 8 个迁移从未建 caller_id 列（`V20260130__init.sql:62` 只有 session_id），
 * 写入 `repo.rs:49/73`、`collector.rs:299` 把 record.caller_id 写进 session_id，读取
 * `repo.rs:497/523` 再从 session_id 映射回 caller_id。Rust 原查询同样报 no such column，
 * 这里按 commander G1 指令改为与写/读映射一致的 session_id；迁移和 schema 不变。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import secrets from '../../secrets/index.ts';
import storage from '../index.ts';
import { CallerType, insertUsage, newUsageRecord } from '../llm-usage.ts';
import { Connection } from '../connection.ts';
import { PROFILES } from '../profiles.ts';
import { DEFAULT_MIGRATIONS_DIR } from '../migration/definitions/index.ts';
import { loadSqlMigrations, Runner } from '../migration/refinery.ts';

let base: string;
let host: Awaited<ReturnType<typeof createTestHost>> | undefined;

beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-llm-session-summary-')); });
afterEach(async () => {
  await host?.dispose();
  host = undefined;
  fs.rmSync(base, { recursive: true, force: true });
});

async function start() {
  const logger = () => ({ debug() {}, info() {}, warn() {}, error() {} });
  host = await createTestHost({
    app: { dataDir: base },
    plugins: [secrets, [storage, { dataLocalDir: base }]],
    provide: {
      paths: { os: { home: base, data: base, dataLocal: base, config: base, temp: base } },
      log: { logger },
      storageStartupSync: { resetDefaultAfterLocalPurge() {} },
    },
    shell: () => null,
  });
  return host;
}

const columns = (h: NonNullable<typeof host>) =>
  h.ctx.storage.database('llm_usage').all<{ name: string }>('PRAGMA table_info(llm_usage_logs)').map((c) => c.name);

it('RF-W07-llm-usage-session-caller-id: fresh database: session summary aggregates rows written with withCallerId (session_id column)', async () => {
  const h = await start();
  const db = h.ctx.storage.database('llm_usage');
  expect(columns(h)).toContain('session_id');
  expect(columns(h)).not.toContain('caller_id');
  insertUsage(db, newUsageRecord(CallerType.ChatV2, 'gpt-4o', 100, 20).withCallerId('sess_a').withEstimatedCost(0.25).build());
  insertUsage(db, newUsageRecord(CallerType.ChatV2, 'gpt-4o', 30, 5).withCallerId('sess_a').withEstimatedCost(0.5).build());
  insertUsage(db, newUsageRecord(CallerType.ChatV2, 'gpt-4o', 999, 999).withCallerId('sess_b').build());
  insertUsage(db, newUsageRecord(CallerType.ChatV2, 'gpt-4o', 7, 7).build());

  expect(await h.invoke('llm_usage_session_summary', { sessionId: 'sess_a' })).toEqual({
    sessionId: 'sess_a', requestCount: 2, promptTokens: 130, completionTokens: 25, totalTokens: 155, estimatedCostUsd: 0.75,
  });
  // SUM(cost_estimate) over only NULL costs is NULL → estimated_cost_usd: None is omitted.
  expect(await h.invoke('llm_usage_session_summary', { sessionId: 'sess_b' })).toEqual({
    sessionId: 'sess_b', requestCount: 1, promptTokens: 999, completionTokens: 999, totalTokens: 1998,
  });
  expect(await h.invoke('llm_usage_session_summary', { sessionId: 'missing' })).toEqual({
    sessionId: 'missing', requestCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
  });
});

it('historical V20260130 database upgraded at startup keeps session rows queryable by session summary', async () => {
  const file = path.join(base, 'slots', 'slotA', 'llm_usage.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const legacy = new Connection(file, { label: 'llm_usage', profile: PROFILES.llm_usage });
  try {
    new Runner(loadSqlMigrations(path.join(DEFAULT_MIGRATIONS_DIR, 'llm_usage')), {
      grouped: false, abortDivergent: false, abortMissing: false, target: { kind: 'Version', version: 20260130 },
    }).run(legacy);
    expect(legacy.pluck('SELECT MAX(version) FROM refinery_schema_history')).toBe(20260130);
    const insert = `INSERT INTO llm_usage_logs
      (id, timestamp, provider, model, prompt_tokens, completion_tokens, total_tokens, caller_type, session_id, status, cost_estimate)
      VALUES (?, '2026-01-31T10:00:00.000Z', 'openai', 'gpt-4o', ?, ?, ?, 'chat_v2', ?, 'success', ?)`;
    legacy.run(insert, ['legacy_1', 40, 10, 50, 'sess_old', 1.5]);
    legacy.run(insert, ['legacy_2', 60, 15, 75, 'sess_old', null]);
    legacy.run(insert, ['legacy_3', 1, 1, 2, 'other', null]);
  } finally { legacy.close(); }

  const h = await start();
  const db = h.ctx.storage.database('llm_usage');
  expect(db.pluck('SELECT MAX(version) FROM refinery_schema_history')).toBe(20260826);
  expect(columns(h)).toEqual(expect.arrayContaining(['session_id', 'cache_write_tokens', 'variant_id', 'run_id']));
  expect(columns(h)).not.toContain('caller_id');
  insertUsage(db, newUsageRecord(CallerType.ChatV2, 'gpt-4o', 5, 5).withCallerId('sess_old').withEstimatedCost(0.5).build());

  expect(await h.invoke('llm_usage_session_summary', { sessionId: 'sess_old' })).toEqual({
    sessionId: 'sess_old', requestCount: 3, promptTokens: 105, completionTokens: 30, totalTokens: 135, estimatedCostUsd: 2,
  });
});

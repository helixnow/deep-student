import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Connection } from '../connection.ts';
import { SqliteDatabase } from '../database.ts';
import { PROFILES } from '../profiles.ts';
import { DEFAULT_MIGRATIONS_DIR, loadMigrationSets } from '../migration/definitions/index.ts';
import { RepairHelpers } from '../migration/helpers.ts';
import { loadSqlMigrations, Runner } from '../migration/refinery.ts';
import { preRepairLlmUsageSchema, type RepairContext } from '../migration/repairs.ts';
import {
  CallerType,
  LLM_USAGE_SCHEMA_VERSION,
  MAX_PENDING_USAGE_RECORDS,
  UsageCollector,
  accumulateDailySummary,
  cacheDebugUsageLine,
  callerTypeDisplayName,
  callerTypeFromStr,
  callerTypeToString,
  clearPendingUsageQueue,
  computeModelAverages,
  deleteOldRecords,
  enqueuePending,
  extractProvider,
  getDailySummary,
  getRecentUsage,
  getSchemaVersion,
  getSessionUsage,
  getStatistics,
  getUsageByCaller,
  getUsageByModel,
  getRecentUsagePage,
  getUsageSummary,
  getUsageTrends,
  insertRecords,
  insertUsage,
  insertUsageBatch,
  last30DaysQuery,
  isForeignKeysEnabled,
  newDailySummary,
  newModelSummary,
  newUsageRecord,
  newUsageTrendPoint,
  pendingUsageQueue,
  timeGranularityDisplay,
} from '../llm-usage.ts';

const dirs: string[] = [];
const opened: SqliteDatabase[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-llm-usage-'));
  dirs.push(dir);
  return dir;
}

const migrationsDir = path.join(DEFAULT_MIGRATIONS_DIR, 'llm_usage');
const migrationList = loadSqlMigrations(migrationsDir);

function migrate(conn: Connection, target?: number): void {
  new Runner(migrationList, {
    grouped: false,
    abortDivergent: false,
    abortMissing: false,
    ...(target === undefined ? {} : { target: { kind: 'Version' as const, version: target } }),
  }).run(conn);
}

function openMigrated(fileName = 'llm_usage.db'): { dir: string; file: string; db: SqliteDatabase } {
  const dir = tempDir();
  const file = path.join(dir, fileName);
  const db = new SqliteDatabase({ name: 'llm_usage', path: file, profile: PROFILES.llm_usage });
  opened.push(db);
  migrate(db.rawConnection());
  return { dir, file, db };
}

function count(db: SqliteDatabase, table: string): number {
  return Number(db.pluck(`SELECT COUNT(*) FROM ${table}`));
}

afterEach(() => {
  for (const db of opened.splice(0)) {
    try { db.close(); } catch (error) { void error; }
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  clearPendingUsageQueue();
});

// ------------------------------------------------------------------ types.rs

it('test_caller_type_display', () => {
  expect(callerTypeToString(CallerType.ChatV2)).toBe('chat_v2');
  expect(callerTypeToString(CallerType.Translation)).toBe('translation');
  expect(callerTypeToString(CallerType.VoiceInput)).toBe('voice_input');
  expect(callerTypeToString(CallerType.Other('custom'))).toBe('other:custom');
});

it('test_caller_type_from_str', () => {
  expect(callerTypeFromStr('chat_v2')).toBe('chat_v2');
  expect(callerTypeFromStr('translation')).toBe('translation');
  expect(callerTypeFromStr('voice_input')).toBe('voice_input');
  expect(callerTypeFromStr('media_transcription')).toBe('media_transcription');
  expect(callerTypeFromStr('other:custom')).toEqual({ other: 'custom' });
  expect(callerTypeFromStr('unknown')).toEqual({ other: 'unknown' });
});

it('test_usage_record_builder', () => {
  const record = newUsageRecord(CallerType.ChatV2, 'gpt-4o', 100, 50)
    .withCallerId('sess_123')
    .withReasoningTokens(20)
    .withEstimatedCost(0.005)
    .build();

  expect(record.callerType).toBe('chat_v2');
  expect(record.modelId).toBe('gpt-4o');
  expect(record.promptTokens).toBe(100);
  expect(record.completionTokens).toBe(50);
  expect(record.totalTokens).toBe(150);
  expect(record.callerId).toBe('sess_123');
  expect(record.reasoningTokens).toBe(20);
  expect(record.estimatedCostUsd).toBe(0.005);
  expect(record.success).toBe(true);
  expect(record.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?\+00:00$/);
});

it('test_daily_summary_accumulate', () => {
  const summary = newDailySummary('2024-01-15');
  const record1 = newUsageRecord(CallerType.ChatV2, 'gpt-4o', 100, 50).build();
  const record2 = newUsageRecord(CallerType.ChatV2, 'gpt-4o', 200, 100).withError('timeout').build();

  accumulateDailySummary(summary, record1);
  accumulateDailySummary(summary, record2);

  expect(summary.requestCount).toBe(2);
  expect(summary.successCount).toBe(1);
  expect(summary.errorCount).toBe(1);
  expect(summary.totalPromptTokens).toBe(300);
  expect(summary.totalCompletionTokens).toBe(150);
  expect(summary.totalTokens).toBe(450);
});

it('test_time_granularity_display', () => {
  expect(timeGranularityDisplay('hour')).toBe('hour');
  expect(timeGranularityDisplay('day')).toBe('day');
  expect(timeGranularityDisplay('week')).toBe('week');
  expect(timeGranularityDisplay('month')).toBe('month');
});

// ------------------------------------------------------------------ repo.rs

it('test_insert_and_query', () => {
  const { db } = openMigrated();
  const record = newUsageRecord(CallerType.ChatV2, 'gpt-4o', 100, 50).build();

  insertUsage(db, record);

  const recent = getRecentUsage(db, 10);
  expect(recent).toHaveLength(1);
  expect(recent[0]!.modelId).toBe('gpt-4o');
});

it('test_get_summary', () => {
  const { db } = openMigrated();
  insertUsage(db, newUsageRecord(CallerType.ChatV2, 'gpt-4o', 100, 50).build());

  const summary = getUsageSummary(db, null, null);
  expect(summary.totalRequests).toBe(1);
  expect(summary.totalTokens).toBe(150);
});

it('test_usage_summary_uses_chrono_date_boundaries', () => {
  const { db } = openMigrated();
  const record = newUsageRecord(CallerType.ChatV2, 'gpt-4o', 100, 50).build();
  record.createdAt = '2026-01-02T03:04:05.123456789+00:00';
  insertUsage(db, record);

  const summary = getUsageSummary(db, '2026-01-01', '2026-01-03');
  // Rust UsageSummary fields are DateTime<Utc>; serde writes UTC as `Z`
  // (types.rs:562-567, chrono serde `to_rfc3339_opts(AutoSi, true)`).
  expect(summary.startDate).toBe('2026-01-01T00:00:00Z');
  expect(summary.endDate).toBe('2026-01-03T23:59:59.999999999Z');
});

it('test_usage_summary_derives_utc_z_from_stored_offsets', () => {
  const { db } = openMigrated();
  const record = newUsageRecord(CallerType.ChatV2, 'gpt-4o', 100, 50).build();
  record.createdAt = '2026-10-01T01:02:03.123456789+08:00';
  insertUsage(db, record);

  const summary = getUsageSummary(db, null, null);
  expect(summary.startDate).toBe('2026-09-30T17:02:03.123456789Z');
  expect(summary.endDate).toBe('2026-09-30T17:02:03.123456789Z');
  // The stored text is not rewritten to the wire representation.
  expect(db.pluck<string>('SELECT timestamp FROM llm_usage_logs WHERE id = ?', [record.id]))
    .toBe('2026-10-01T01:02:03.123456789+08:00');
});

it('test_recent_usage_canonicalizes_rfc3339_timestamps', () => {
  const { db } = openMigrated();
  const record = newUsageRecord(CallerType.ChatV2, 'gpt-4o', 100, 50).build();
  record.createdAt = '2026-10-01T01:02:03.123456789+08:00';
  insertUsage(db, record);

  const [recent] = getRecentUsagePage(db, 0, 10);
  expect(recent?.createdAt).toBe('2026-09-30T17:02:03.123456789Z');
  expect(db.pluck<string>('SELECT timestamp FROM llm_usage_logs WHERE id = ?', [record.id]))
    .toBe('2026-10-01T01:02:03.123456789+08:00');
});

it('test_recent_usage_invalid_timestamp_uses_epoch_z_without_rewriting_stored_text', () => {
  const { db } = openMigrated();
  const record = newUsageRecord(CallerType.ChatV2, 'gpt-4o', 100, 50).build();
  insertUsage(db, record);
  db.run("UPDATE llm_usage_logs SET timestamp = 'not-a-timestamp' WHERE id = ?", [record.id]);

  const [recent] = getRecentUsagePage(db, 0, 10);
  // repo.rs:509-518 falls back to UNIX_EPOCH, whose chrono serde form is `Z`.
  expect(recent?.createdAt).toBe('1970-01-01T00:00:00Z');
  expect(db.pluck<string>('SELECT timestamp FROM llm_usage_logs WHERE id = ?', [record.id]))
    .toBe('not-a-timestamp');
});

it('test_insert_usage_batch_skips_failed_rows_and_commits_successes', () => {
  const { db } = openMigrated();
  const first = newUsageRecord(CallerType.ChatV2, 'gpt-4o', 100, 50).build();
  const duplicate = { ...first };

  expect(insertUsageBatch(db, [first, duplicate])).toBe(1);
  expect(count(db, 'llm_usage_logs')).toBe(1);
});

it('test_insert_records_rolls_back_with_record_context', () => {
  const { db } = openMigrated();
  const first = newUsageRecord(CallerType.ChatV2, 'gpt-4o', 100, 50).build();
  const duplicate = { ...first };

  expect(() => insertRecords({ getConnSafe: () => db }, [first, duplicate]))
    .toThrow(new RegExp(`^Failed to insert record ${first.id}:`));
  expect(count(db, 'llm_usage_logs')).toBe(0);
});

it('last_30_days_query_uses_rfc3339_offsets', () => {
  const query = last30DaysQuery();
  expect(query.startDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?\+00:00$/);
  expect(query.endDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?\+00:00$/);
  const delta = Date.parse(query.endDate!) - Date.parse(query.startDate!);
  expect(delta).toBe(30 * 24 * 60 * 60 * 1000);
});

it('test_insert_usage_writes_real_adapter_and_token_source', () => {
  const { db } = openMigrated();
  const record = newUsageRecord(CallerType.ChatV2, 'claude-3-opus', 100, 50)
    .withAdapter('anthropic_messages')
    .withTokenSource('heuristic')
    .build();

  insertUsage(db, record);

  const row = db.get('SELECT adapter, token_source FROM llm_usage_logs WHERE id = ?', [record.id]);
  expect(row?.adapter).toBe('anthropic_messages');
  expect(row?.token_source).toBe('heuristic');

  const recent = getRecentUsage(db, 10);
  expect(recent[0]!.adapter).toBe('anthropic_messages');
  expect(recent[0]!.tokenSource).toBe('heuristic');
});

it('test_cache_debug_usage_line_reports_hit_ratio', () => {
  const record = newUsageRecord(CallerType.ChatV2, 'glm-5.3-flash', 1000, 50).withCachedTokens(750).build();
  const line = cacheDebugUsageLine(record);
  expect(line.startsWith('[PromptCache] usage:')).toBe(true);
  expect(line).toContain('prompt=1000');
  expect(line).toContain('cached=750');
  expect(line).toContain('hit=75.0%');

  const empty = newUsageRecord(CallerType.ChatV2, 'gpt-4o', 0, 0).build();
  expect(cacheDebugUsageLine(empty)).toContain('hit=0.0%');
});

it('test_insert_usage_persists_cache_write_tokens_and_null_unmeasured', () => {
  const { db } = openMigrated();
  const measured = newUsageRecord(CallerType.ChatV2, 'claude-3-opus', 1000, 50)
    .withCachedTokens(750)
    .withCacheWriteTokens(250)
    .build();
  const unmeasured = newUsageRecord(CallerType.ChatV2, 'gpt-4o', 100, 10).build();

  insertUsage(db, measured);
  insertUsage(db, unmeasured);

  const measuredRow = db.get('SELECT cached_tokens, cache_write_tokens FROM llm_usage_logs WHERE id = ?', [measured.id]);
  expect(measuredRow?.cached_tokens).toBe(750);
  expect(measuredRow?.cache_write_tokens).toBe(250);

  const plainRow = db.get('SELECT cached_tokens, cache_write_tokens FROM llm_usage_logs WHERE id = ?', [unmeasured.id]);
  expect(plainRow?.cached_tokens).toBeNull();
  expect(plainRow?.cache_write_tokens).toBeNull();

  const recent = getRecentUsage(db, 10);
  expect(recent.find((row) => row.id === measured.id)?.cacheWriteTokens).toBe(250);
  expect(recent.find((row) => row.id === unmeasured.id)?.cacheWriteTokens).toBeUndefined();
});

it('test_insert_usage_prefers_explicit_provider_id', () => {
  const { db } = openMigrated();
  const record = newUsageRecord(CallerType.VoiceInput, 'TeleAI/TeleSpeechASR', 0, 0)
    .withProviderId('siliconflow')
    .build();

  insertUsage(db, record);

  expect(db.pluck('SELECT provider FROM llm_usage_logs WHERE id = ?', [record.id])).toBe('siliconflow');
});

// ------------------------------------------------------------------ database.rs

it('test_database_creation', () => {
  const { file, db } = openMigrated();
  expect(fs.existsSync(file)).toBe(true);
  expect(db.path).toBe(file);
});

it('test_migrations_idempotent', () => {
  const { db } = openMigrated();
  expect(getSchemaVersion(db)).toBe(LLM_USAGE_SCHEMA_VERSION);

  migrate(db.rawConnection());
  expect(getSchemaVersion(db)).toBe(LLM_USAGE_SCHEMA_VERSION);
});

it('test_direct_initializer_repairs_v20260824_column_without_history', () => {
  const dir = tempDir();
  const file = path.join(dir, 'llm_usage.db');
  const db = new SqliteDatabase({ name: 'llm_usage', path: file, profile: PROFILES.llm_usage });
  opened.push(db);
  const conn = db.rawConnection();
  migrate(conn, 20260525);
  conn.run(
    `INSERT INTO llm_usage_logs (
        id, timestamp, provider, model, caller_type,
        prompt_tokens, completion_tokens, total_tokens
     ) VALUES (
        'old-row', '2026-08-09T00:00:00Z', 'openai', 'gpt-4o',
        'chat_v2', 10, 5, 15
     )`,
  );
  conn.exec(fs.readFileSync(path.join(migrationsDir, 'V20260824__add_cache_write_tokens.sql'), 'utf8'));

  const sets = loadMigrationSets(DEFAULT_MIGRATIONS_DIR);
  const runner = new Runner(migrationList, { grouped: false, abortDivergent: false, abortMissing: false });
  const ctx: RepairContext = {
    h: new RepairHelpers(conn, () => undefined),
    id: 'llm_usage',
    runner,
    set: sets.llm_usage,
    migrationsDir: DEFAULT_MIGRATIONS_DIR,
  };
  preRepairLlmUsageSchema(ctx);
  runner.run(conn);

  expect(getSchemaVersion(db)).toBe(LLM_USAGE_SCHEMA_VERSION);
  expect(db.pluck('SELECT COUNT(*) FROM refinery_schema_history WHERE version = 20260824')).toBe(1);
  expect(db.pluck("SELECT cache_write_tokens FROM llm_usage_logs WHERE id = 'old-row'")).toBeNull();
});

it('test_foreign_keys_enabled', () => {
  const { db } = openMigrated();
  expect(isForeignKeysEnabled(db)).toBe(true);
});

it('test_get_connection', () => {
  const { db } = openMigrated();
  expect(db.pluck('SELECT 1')).toBe(1);
  expect(db.pluck('SELECT 1')).toBe(1);
});

it('test_get_statistics', () => {
  const { db } = openMigrated();
  const stats = getStatistics(db);
  expect(stats.logCount).toBe(0);
  expect(stats.dailySummaryCount).toBe(0);
  expect(stats.totalTokens).toBe(0);
  expect(stats.totalCostEstimate).toBe(0);
  expect(stats.schemaVersion).toBe(LLM_USAGE_SCHEMA_VERSION);
});

it('test_tables_created', () => {
  const { db } = openMigrated();
  for (const table of ['llm_usage_logs', 'llm_usage_daily']) {
    expect(db.pluck("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", [table])).toBe(1);
  }
});

it('test_indexes_created', () => {
  const { db } = openMigrated();
  for (const index of [
    'idx_llm_usage_logs_timestamp',
    'idx_llm_usage_logs_date_key',
    'idx_llm_usage_logs_caller_type',
    'idx_llm_usage_logs_model',
    'idx_llm_usage_daily_date',
  ]) {
    expect(db.pluck("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?", [index])).toBe(1);
  }
});

it('test_insert_usage_log', () => {
  const { db } = openMigrated();
  db.run(
    `INSERT INTO llm_usage_logs (
        id, timestamp, provider, model, prompt_tokens, completion_tokens,
        total_tokens, caller_type, status
     ) VALUES (
        'usage_test_001', '2025-01-23T10:30:00.000Z', 'openai', 'gpt-4o',
        100, 50, 150, 'chat_v2', 'success'
     )`,
  );

  expect(db.pluck("SELECT COUNT(*) FROM llm_usage_logs WHERE id = 'usage_test_001'")).toBe(1);
  expect(db.pluck("SELECT date_key FROM llm_usage_logs WHERE id = 'usage_test_001'")).toBe('2025-01-23');
});

it('test_daily_summary_upsert', () => {
  const { db } = openMigrated();
  db.run(
    `INSERT INTO llm_usage_daily (
        date, caller_type, model, provider, request_count, success_count,
        total_prompt_tokens, total_completion_tokens, total_tokens
     ) VALUES (
        '2025-01-23', 'chat_v2', 'gpt-4o', 'openai', 10, 9, 1000, 500, 1500
     )`,
  );

  expect(db.pluck("SELECT request_count FROM llm_usage_daily WHERE date = '2025-01-23' AND caller_type = 'chat_v2'")).toBe(10);
});

it('test_maintenance_barrier_fails_closed_and_preserves_data', async () => {
  const { db } = openMigrated();
  db.run(
    `INSERT INTO llm_usage_logs (
        id, timestamp, provider, model, prompt_tokens, completion_tokens,
        total_tokens, caller_type, status
     ) VALUES (
        'usage_barrier_test', '2026-01-23T10:30:00.000Z', 'openai', 'gpt-4o',
        100, 50, 150, 'chat_v2', 'success'
     )`,
  );

  await db.enterMaintenance(Date.now() + 5000);
  expect(db.inMaintenance).toBe(true);
  expect(() => db.get('SELECT 1')).toThrow(expect.objectContaining({ code: 'MAINTENANCE' }));
  await expect(db.enterMaintenance(Date.now() + 5000)).rejects.toMatchObject({ code: 'MAINTENANCE' });

  db.exitMaintenance();
  expect(db.inMaintenance).toBe(false);
  expect(db.pluck("SELECT COUNT(*) FROM llm_usage_logs WHERE id = 'usage_barrier_test'")).toBe(1);
});

it('test_maintenance_barrier_drains_in_flight_connections_or_fails', async () => {
  const { db } = openMigrated();
  db.exitMaintenance();

  const held = await db.begin();
  await expect(db.enterMaintenance(Date.now() + 150)).rejects.toMatchObject({ code: 'MAINTENANCE_DRAIN_TIMEOUT' });
  expect(db.inMaintenance).toBe(false);
  expect(db.pluck('SELECT 1')).toBe(1);

  await held.rollback();
  await db.enterMaintenance(Date.now() + 5000);
  db.exitMaintenance();
});

it('test_reinitialize', () => {
  const { file, db } = openMigrated();
  db.run(
    `INSERT INTO llm_usage_logs (
        id, timestamp, provider, model, prompt_tokens, completion_tokens,
        total_tokens, caller_type, status
     ) VALUES (
        'usage_reinit_test', '2025-01-23T10:30:00.000Z', 'openai', 'gpt-4o',
        100, 50, 150, 'chat_v2', 'success'
     )`,
  );

  db.close();
  const reopened = new SqliteDatabase({ name: 'llm_usage', path: file, profile: PROFILES.llm_usage });
  opened.push(reopened);

  expect(reopened.pluck("SELECT COUNT(*) FROM llm_usage_logs WHERE id = 'usage_reinit_test'")).toBe(1);
  expect(reopened.path).toBe(file);
});

// ------------------------------------------------------------------ collector.rs

function collectorFor(db: SqliteDatabase): UsageCollector {
  return new UsageCollector({ getConnSafe: () => db });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

it('test_collector_creation', async () => {
  const { db } = openMigrated();
  const collector = collectorFor(db);
  expect(collector.isShutdown()).toBe(false);
  await collector.shutdown();
});

it('test_record_single', async () => {
  const { db } = openMigrated();
  const collector = collectorFor(db);

  collector.record(newUsageRecord(CallerType.ChatV2, 'gpt-4o', 100, 50).build());
  await sleep(5600);

  expect(count(db, 'llm_usage_logs')).toBe(1);
  await collector.shutdown();
});

it('test_record_from_api_response', async () => {
  const { db } = openMigrated();
  const collector = collectorFor(db);

  collector.recordFromApiResponse(CallerType.Translation, 'claude-3-opus', 200, 100, 'session_test', 1500, true, null);
  await sleep(5600);

  const row = db.get('SELECT caller_type, model, session_id FROM llm_usage_logs LIMIT 1');
  expect(row?.caller_type).toBe('translation');
  expect(row?.model).toBe('claude-3-opus');
  expect(row?.session_id).toBe('session_test');
  await collector.shutdown();
});

it('test_record_batch', async () => {
  const { db } = openMigrated();
  const collector = collectorFor(db);

  const records = Array.from({ length: 10 }, (_, i) =>
    newUsageRecord(CallerType.Anki, 'gpt-4o-mini', 50 + i, 25 + i).build());
  collector.recordBatch(records);
  await sleep(500);

  expect(count(db, 'llm_usage_logs')).toBe(10);
  await collector.shutdown();
});

it('test_record_writes_real_adapter_and_token_source', async () => {
  const { db } = openMigrated();
  const collector = collectorFor(db);

  const record = newUsageRecord(CallerType.ChatV2, 'deepseek-chat', 100, 50)
    .withAdapter('openai_responses')
    .withTokenSource('tiktoken')
    .build();
  const plain = newUsageRecord(CallerType.ChatV2, 'gpt-4o', 10, 5).build();

  collector.recordBatch([record, plain]);
  await sleep(500);

  const annotated = db.get('SELECT adapter, token_source FROM llm_usage_logs WHERE id = ?', [record.id]);
  expect(annotated?.adapter).toBe('openai_responses');
  expect(annotated?.token_source).toBe('tiktoken');

  const plainRow = db.get('SELECT adapter, token_source FROM llm_usage_logs WHERE id = ?', [plain.id]);
  expect(plainRow?.adapter).toBeNull();
  expect(plainRow?.token_source).toBe('api');
  await collector.shutdown();
});

it('test_record_writes_cache_write_tokens_null_means_unmeasured', async () => {
  const { db } = openMigrated();
  const collector = collectorFor(db);

  const measured = newUsageRecord(CallerType.ChatV2, 'claude-3-opus', 1000, 50)
    .withCachedTokens(800)
    .withCacheWriteTokens(200)
    .build();
  const unmeasured = newUsageRecord(CallerType.ChatV2, 'gpt-4o', 10, 5).build();

  collector.recordBatch([measured, unmeasured]);
  await sleep(500);

  const measuredRow = db.get('SELECT cached_tokens, cache_write_tokens FROM llm_usage_logs WHERE id = ?', [measured.id]);
  expect(measuredRow?.cached_tokens).toBe(800);
  expect(measuredRow?.cache_write_tokens).toBe(200);

  const plainRow = db.get('SELECT cached_tokens, cache_write_tokens FROM llm_usage_logs WHERE id = ?', [unmeasured.id]);
  expect(plainRow?.cached_tokens).toBeNull();
  expect(plainRow?.cache_write_tokens).toBeNull();
  await collector.shutdown();
});

it('test_shutdown', async () => {
  const { db } = openMigrated();
  const collector = collectorFor(db);

  for (let i = 0; i < 5; i++) {
    collector.record(newUsageRecord(CallerType.Analysis, 'deepseek-chat', 100 + i, 50 + i).build());
  }
  await collector.shutdown();

  expect(collector.isShutdown()).toBe(true);
  expect(count(db, 'llm_usage_logs')).toBe(5);
});

it('test_record_after_shutdown', async () => {
  const { db } = openMigrated();
  const collector = collectorFor(db);
  await collector.shutdown();

  collector.record(newUsageRecord(CallerType.ChatV2, 'gpt-4o', 100, 50).build());

  expect(collector.isShutdown()).toBe(true);
  expect(count(db, 'llm_usage_logs')).toBe(0);
});

it('test_record_with_error', async () => {
  const { db } = openMigrated();
  const collector = collectorFor(db);

  collector.recordFromApiResponse(CallerType.ExamSheet, 'gpt-4o', 100, 0, null, 5000, false, 'Rate limit exceeded');
  await sleep(5600);

  const row = db.get('SELECT status, error_message FROM llm_usage_logs LIMIT 1');
  expect(row?.status).toBe('error');
  expect(row?.error_message).toBe('Rate limit exceeded');
  await collector.shutdown();
});

it('test_extract_provider', () => {
  expect(extractProvider('gpt-4o')).toBe('openai');
  expect(extractProvider('gpt-4o-mini')).toBe('openai');
  expect(extractProvider('o1-preview')).toBe('openai');
  expect(extractProvider('claude-3-opus')).toBe('anthropic');
  expect(extractProvider('claude-3-5-sonnet')).toBe('anthropic');
  expect(extractProvider('deepseek-chat')).toBe('deepseek');
  expect(extractProvider('deepseek-coder')).toBe('deepseek');
  expect(extractProvider('qwen-turbo')).toBe('alibaba');
  expect(extractProvider('gemini-pro')).toBe('google');
  expect(extractProvider('llama-3-70b')).toBe('siliconflow');
  expect(extractProvider('mistral-large')).toBe('siliconflow');
  expect(extractProvider('custom-model')).toBe('unknown');
});

// ------------------------------------------------------------------ mod.rs

it('pending_queue_is_bounded', () => {
  clearPendingUsageQueue();
  for (let i = 0; i < MAX_PENDING_USAGE_RECORDS + 10; i++) {
    enqueuePending(newUsageRecord(CallerType.ChatV2, `m-${i}`, 1, 1).build());
  }

  const queue = pendingUsageQueue();
  expect(queue).toHaveLength(MAX_PENDING_USAGE_RECORDS);
  expect(queue[0]!.modelId).toBe('m-10');
});

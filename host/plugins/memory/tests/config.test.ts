import fs from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { StorageServiceImpl } from '../../../platform/storage/service.ts';
import { StorageError } from '../../../platform/storage/api.ts';
import { createMigratedMemoryStorage } from './fixtures/migrated-schema.ts';
import memory from '../index.ts';
import { i64ToF32 } from '../src/f32.ts';
import {
  createIndexDouble, createLogDouble, createNotesDouble, createReposDouble, createRetrievalDouble,
  createSettingsDouble,
} from './support.ts';
import { CONFIG_KEYS, DEFAULT_EVOLUTION_TUNING, DEFAULT_FOLDER_TITLE,
  contentMinChars, evolutionIntervalMs, frequencyFromStrLossy, shouldRefreshCategories } from '../src/config.ts';

let host: TestHost | undefined;
let storage: StorageServiceImpl | undefined;
let dir: string | undefined;
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});
async function setup() {
  const fixture = await createMigratedMemoryStorage('memory-config-');
  ({ dir, storage } = fixture);
  const { report } = fixture;
  expect(report.success).toBe(true);
  const db = storage.database('vfs');
  host = await createTestHost({
    plugins: [memory],
    provide: {
      storage, 'notes': createNotesDouble(db),
      'vfsRepo': createReposDouble(),
      'retrieval': createRetrievalDouble(db), 'vfsIndex': createIndexDouble(),
      log: createLogDouble([]),
      settings: createSettingsDouble(db),
    },
  });
  return { host, db };
}

it('test_config_key_constants', () => {
  expect(CONFIG_KEYS.rootFolderId).toBe('memory_root_folder_id');
  expect(CONFIG_KEYS.autoCreateSubfolders).toBe('auto_create_subfolders');
  expect(CONFIG_KEYS.defaultCategory).toBe('default_category');
  expect(CONFIG_KEYS.privacyMode).toBe('privacy_mode');
  expect(CONFIG_KEYS.autoExtractFrequency).toBe('auto_extract_frequency');
  expect(DEFAULT_FOLDER_TITLE).toBe('记忆');
});
it('test_evolution_tuning_key_constants_and_defaults', () => {
  for (const key of ['stale_hit_days', 'stale_injected_days', 'archive_after_stale_days',
    'category_quota', 'semantic_merge_max_pairs', 'semantic_merge_min_score', 'stale_min_hits'] as const) {
    expect(CONFIG_KEYS[key]).toBe(`evolution_${key}`);
  }
  expect(DEFAULT_EVOLUTION_TUNING.stale_injected_days).toBeGreaterThan(DEFAULT_EVOLUTION_TUNING.stale_hit_days);
  expect(DEFAULT_EVOLUTION_TUNING.stale_min_hits).toBe(2);
  expect(DEFAULT_EVOLUTION_TUNING.archive_after_stale_days).toBe(90);
  expect(DEFAULT_EVOLUTION_TUNING.category_quota).toBe(50);
  expect(DEFAULT_EVOLUTION_TUNING.semantic_merge_max_pairs).toBe(3);
  expect(DEFAULT_EVOLUTION_TUNING.semantic_merge_min_score).toBeGreaterThan(0);
});
it('test_auto_extract_frequency', () => {
  expect(frequencyFromStrLossy('off')).toBe('off');
  expect(frequencyFromStrLossy('balanced')).toBe('balanced');
  expect(frequencyFromStrLossy('aggressive')).toBe('aggressive');
  expect(frequencyFromStrLossy('unknown')).toBe('balanced');
  expect(contentMinChars('balanced')).toBe(10);
  expect(contentMinChars('aggressive')).toBe(4);
  expect(evolutionIntervalMs('off')).toBe(24 * 60 * 60 * 1000);
  expect(evolutionIntervalMs('balanced')).toBe(30 * 60 * 1000);
  expect(shouldRefreshCategories('aggressive', 3)).toBe(true);
  expect(shouldRefreshCategories('balanced', 7)).toBe(false);
  expect(shouldRefreshCategories('balanced', 10)).toBe(true);
});
it('configuration IPC persists exact keys and values, with Rust defaults and no change events', async () => {
  const { host, db } = await setup();
  expect(host.ctx.memory.isPrivacyMode()).toBe(false);
  expect(host.ctx.memory.isAutoCreateSubfolders()).toBe(true);
  expect(host.ctx.memory.getDefaultCategory()).toBe('通用');
  expect(host.ctx.memory.getAutoExtractFrequency()).toBe('balanced');
  await expect(host.invoke('memory_set_privacy_mode', { enabled: true })).resolves.toBeNull();
  await expect(host.invoke('memory_set_auto_create_subfolders', { enabled: false })).resolves.toBeNull();
  await expect(host.invoke('memory_set_default_category', { category: '' })).resolves.toBeNull();
  await expect(host.invoke('memory_set_auto_extract_frequency', { frequency: ' AGGRESSIVE ' })).resolves.toBeNull();
  expect(db.all('SELECT key, value FROM memory_config ORDER BY key')).toEqual([
    { key: 'auto_create_subfolders', value: 'false' },
    { key: 'auto_extract_frequency', value: 'aggressive' },
    { key: 'default_category', value: '' },
    { key: 'file_root_folder_id', value: '' },
    { key: 'memory_root_folder_id', value: '' },
    { key: 'privacy_mode', value: 'true' },
  ]);
  expect(host.ctx.memory.isPrivacyMode()).toBe(true);
  expect(host.ctx.memory.isAutoCreateSubfolders()).toBe(false);
  expect(host.ctx.memory.getDefaultCategory()).toBe('通用');
  expect(host.ctx.memory.getAutoExtractFrequency()).toBe('aggressive');
  await expect(host.invoke('memory_set_auto_extract_frequency', { frequency: ' BAD ' })).rejects.toBe(
    "Invalid auto extract frequency 'bad', expected one of: off, balanced, aggressive");
  expect(host.eventsNamed('memory://changed')).toEqual([]);
});
it('configuration read swallows SQL query errors but writes surface VfsError Display', async () => {
  const { host, db } = await setup();
  db.exec('DROP TABLE memory_config');
  expect(host.ctx.memory.getDefaultCategory()).toBe('通用');
  await expect(host.invoke('memory_set_privacy_mode', { enabled: true })).rejects.toBe(
    'Database error: no such table: memory_config');
});
it('evolution tuning preserves typed parsing, clamping and f32 rounding', async () => {
  const { host, db } = await setup();
  for (const [key, value] of Object.entries({ stale_hit_days: '-10', stale_injected_days: 'oops',
    stale_min_hits: '-1', category_quota: '0', semantic_merge_max_pairs: '0',
    semantic_merge_min_score: '2.5', semantic_dedup_interval_minutes: '2' })) {
    db.run('INSERT INTO memory_config (key, value) VALUES (?1, ?2)', [`evolution_${key}`, value]);
  }
  expect(host.ctx.memory.getEvolutionTuning()).toEqual({
    stale_hit_days: 1, stale_injected_days: 180, stale_min_hits: 2,
    archive_after_stale_days: 90, category_quota: 1, semantic_merge_max_pairs: 0,
    semantic_merge_min_score: 1, semantic_dedup_interval_minutes: 30,
  });
});
it('audit command filters in Rust order, clamps pagination and retains nullable fields', async () => {
  const { host, db } = await setup();
  for (const [source, operation, success] of [['handler', 'write', 1], ['handler', 'delete', 0],
    ['tool_call', 'write', 1]] as const) {
    db.run('INSERT INTO memory_audit_log (source, operation, success, confidence) VALUES (?1, ?2, ?3, ?4)',
      [source, operation, success, 0.7]);
  }
  const logs = await host.invoke('memory_get_audit_logs', { limit: 0 }) as Array<Record<string, unknown>>;
  expect(logs).toHaveLength(1);
  expect(logs[0]).toEqual({
    id: 3, timestamp: expect.any(String), source: 'tool_call', operation: 'write', success: true,
    noteId: null, title: null, contentPreview: null, folder: null, event: null,
    confidence: 0.7, reason: null, sessionId: null, durationMs: null,
  });
  const filtered = await host.invoke('memory_get_audit_logs', {
    sourceFilter: 'handler', operationFilter: 'delete', successFilter: false,
  }) as Array<Record<string, unknown>>;
  expect(filtered.map(row => row.id)).toEqual([2]);
  expect(filtered[0]!.success).toBe(false);
  expect(await host.invoke('memory_get_audit_logs', { sourceFilter: '' })).toEqual([]);
  const offset = await host.invoke('memory_get_audit_logs', { offset: 1 }) as Array<Record<string, unknown>>;
  expect(offset.map(row => row.id)).toEqual([2, 1]);
});
it('audit_log.rs query_audit_logs keeps legal i64 id/duration_ms exact inside Host; wire is the JSON number projection', async () => {
  const { host, db } = await setup();
  const insert = 'INSERT INTO memory_audit_log (id, source, operation, success, duration_ms) VALUES (?1, ?2, ?3, ?4, ?5)';
  db.run(insert, [9007199254740992n, 'handler', 'write', 1, 9007199254740992n]);
  db.run(insert, [9007199254740993n, 'handler', 'write', 0, 9007199254740993n]);
  db.run(insert, [9223372036854775807n, 'tool_call', 'search', 1, -9223372036854775808n]);
  db.run(insert, [-9223372036854775808n, 'tool_call', 'search', 1, 9223372036854775807n]);
  const records = host.ctx.memory.queryAuditLogs(50, 0, null, null, null);
  expect(records.map(row => row.id)).toEqual([9223372036854775807n, 9007199254740993n,
    9007199254740992n, -9223372036854775808n]);
  expect(records.map(row => row.durationMs)).toEqual([-9223372036854775808n, 9007199254740993n,
    9007199254740992n, 9223372036854775807n]);
  expect(records[1]!.id).not.toBe(9007199254740992n);
  expect(records[1]!.success).toBe(false);
  expect(host.ctx.memory.queryAuditLogs(50, 0, 'handler', 'write', false).map(row => row.id))
    .toEqual([9007199254740993n]);
  // Rust serde_json writes the exact token; the renderer's JSON.parse yields the same IEEE-754 number.
  const wire = await host.invoke('memory_get_audit_logs', { sourceFilter: 'handler' }) as Array<Record<string, unknown>>;
  expect(wire.map(row => [row.id, row.durationMs])).toEqual([
    [JSON.parse('9007199254740993'), JSON.parse('9007199254740993')],
    [JSON.parse('9007199254740992'), JSON.parse('9007199254740992')],
  ]);
  const extremes = await host.invoke('memory_get_audit_logs', { sourceFilter: 'tool_call' }) as Array<Record<string, unknown>>;
  expect(extremes.map(row => [row.id, row.durationMs])).toEqual([
    [JSON.parse('9223372036854775807'), JSON.parse('-9223372036854775808')],
    [JSON.parse('-9223372036854775808'), JSON.parse('9223372036854775807')],
  ]);
});
it('audit_log.rs query_audit_logs rejects mismatched SQLite types with rusqlite Row::get Display', async () => {
  const { host, db } = await setup();
  db.run("INSERT INTO memory_audit_log (id, source, operation, duration_ms) VALUES (1, 'handler', 'write', 1.5)");
  const failure = (() => {
    try { host.ctx.memory.queryAuditLogs(50, 0, null, null, null); }
    catch (error) { return error; }
    return undefined;
  })();
  expect(failure).toBeInstanceOf(StorageError);
  expect((failure as StorageError).message).toBe('Invalid column type Real at index: 13, name: duration_ms');
  await expect(host.invoke('memory_get_audit_logs', {})).rejects.toBe(
    'Database error: Invalid column type Real at index: 13, name: duration_ms');
  db.run("INSERT INTO memory_audit_log (id, source, operation, success, title) VALUES (2, 'handler', 'write', 4294967296, x'00')");
  await expect(host.invoke('memory_get_audit_logs', {})).rejects.toBe(
    'Database error: Integer 4294967296 out of range at index 4');
  db.run("UPDATE memory_audit_log SET success = 1 WHERE id = 2");
  await expect(host.invoke('memory_get_audit_logs', {})).rejects.toBe(
    'Database error: Invalid column type Blob at index: 6, name: title');
  db.run("INSERT INTO memory_audit_log (id, source, operation, duration_ms) VALUES (3, 'handler', 'write', 'abc')");
  await expect(host.invoke('memory_get_audit_logs', { limit: 1 })).rejects.toBe(
    'Database error: Invalid column type Text at index: 13, name: duration_ms');
  db.exec('DROP TABLE memory_audit_log');
  await expect(host.invoke('memory_get_audit_logs', {})).rejects.toBe(
    'Database error: no such table: memory_audit_log');
});
it('audit_log.rs Option<f32> Integer branch is a single i64-as-f32 rounding', () => {
  // 2^54 + 2^30 + 1 sits above the f32 midpoint; rounding through f64 first lands on 2^54.
  expect(i64ToF32(2n ** 54n + 2n ** 30n + 1n)).toBe(Math.fround(2 ** 54 + 2 ** 31));
  expect(i64ToF32(-(2n ** 54n + 2n ** 30n + 1n))).toBe(-Math.fround(2 ** 54 + 2 ** 31));
  expect(i64ToF32(2n ** 54n + 2n ** 30n)).toBe(2 ** 54);
  expect(i64ToF32(2n ** 54n + 3n * 2n ** 30n)).toBe(2 ** 54 + 2 ** 32);
  expect(i64ToF32(-9223372036854775808n)).toBe(-(2 ** 63));
  expect(i64ToF32(9223372036854775807n)).toBe(2 ** 63);
  expect(i64ToF32(16777217n)).toBe(16777216);
  expect(i64ToF32(7n)).toBe(7);
});

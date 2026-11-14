/**
 * [L20-engine port] `sync_real_flow_smoke_tests.rs` (first three flows).
 *
 * Both source and target are F3 `StorageService` instances whose production
 * migrations ran via `storage.migrations.runAll()`; the test then drives the
 * published `ctx.sync` pending/enrich/apply/mark-synced path directly. This is
 * the same real migrated schema the app ships, not a hand-written toy schema.
 *
 * The remaining smoke tests (all-RowSync bundle, delete tombstones, business
 * unique-key aliasing, legacy non-RowSync filtering) are still pending; they
 * need the classification registry/asset paths or larger fixtures.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService, type StorageService } from '../../../platform/storage/service.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { compression } from '../../../platform/native/compression/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import notes from '../../notes/index.ts';
import syncSupport from '../../sync-support/index.ts';
import review from '../../review/index.ts';
import sync from '../../sync/index.ts';
import type { EngineChange } from '../../sync/api.ts';

const DEVICE_ID = 'device-local';
let root: string;
let sourceStorage: StorageService;
let targetStorage: StorageService;
let host: TestHost;

function unused(service: string): object {
  return new Proxy({}, {
    get: (_target, key) => {
      if (typeof key === 'symbol' || key === 'then') return undefined;
      throw new Error(`test unexpectedly entered ${service}.${String(key)}`);
    },
  });
}

function clearChangeLog(db: DatabaseHandle): void {
  db.exec('DELETE FROM __change_log');
}

function pendingCount(db: DatabaseHandle): number {
  return host.ctx.sync.getPendingChanges(db, null, null).total_count;
}

function cloudChanges(db: DatabaseHandle, databaseName: string): EngineChange[] {
  const pending = host.ctx.sync.getPendingChanges(db, null, null);
  expect(pending.total_count).toBeGreaterThan(0);
  const changes = host.ctx.sync.enrichChangesWithData(db, pending.entries, null);
  for (const change of changes) {
    change.database_name = databaseName;
    change.suppress_change_log = true;
  }
  return changes;
}

function reverseForFkStress(changes: EngineChange[]): EngineChange[] {
  return [...changes].reverse();
}

function insertVfsNoteBundle(
  db: DatabaseHandle, resId: string, noteId: string, hash: string, title: string,
): void {
  const createdMs = 1_714_000_000_000;
  const createdIso = '2024-04-24T00:00:00Z';
  db.run(
    `INSERT INTO resources (
       id, hash, type, storage_mode, data, metadata_json, ref_count, created_at, updated_at
     ) VALUES (?1,?2,'note','inline',?3,'{}',1,?4,?4)`,
    [resId, hash, `body for ${title}`, createdMs],
  );
  db.run(
    `INSERT INTO notes (
       id, resource_id, title, tags, is_favorite, created_at, updated_at
     ) VALUES (?1,?2,?3,'[]',0,?4,?4)`,
    [noteId, resId, title, createdIso],
  );
}

function insertChatBundle(db: DatabaseHandle): void {
  const now = '2024-04-24T00:00:00Z';
  const ts = 1_714_000_000_000;
  db.run(
    `INSERT INTO chat_v2_sessions (
       id, mode, title, persist_status, created_at, updated_at, metadata_json
     ) VALUES ('sess_real_1','general_chat','Real chat','active',?1,?1,'{}')`,
    [now],
  );
  db.run(
    `INSERT INTO chat_v2_messages (
       id, session_id, role, block_ids_json, timestamp, attachments_json, updated_at
     ) VALUES ('msg_real_1','sess_real_1','assistant','["blk_real_1"]',?1,'[{"id":"att_real_1"}]',?2)`,
    [ts, now],
  );
  db.run(
    `INSERT INTO chat_v2_blocks (
       id, message_id, block_type, status, block_index, content, started_at, ended_at, updated_at
     ) VALUES ('blk_real_1','msg_real_1','content','success',0,'streamed content',?1,?1,?2)`,
    [ts, now],
  );
  db.run(
    `INSERT INTO chat_v2_attachments (
       id, message_id, block_id, name, type, mime_type, size, status, storage_path,
       content_hash, created_at, updated_at
     ) VALUES ('att_real_1','msg_real_1','blk_real_1','scan.pdf','document',
       'application/pdf',42,'ready','active/documents/scan.pdf','hash_scan_pdf',?1,?1)`,
    [now],
  );
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'l23-real-flow-sync-'));
  sourceStorage = createStorageService({ baseDir: join(root, 'source'), dataLocalDir: join(root, 'source') });
  targetStorage = createStorageService({ baseDir: join(root, 'target'), dataLocalDir: join(root, 'target') });
  await sourceStorage.migrations.runAll();
  await targetStorage.migrations.runAll();

  host = await createTestHost();
  host.ctx.provide('storage', sourceStorage);
  host.ctx.provide('paths', {
    deviceId: async () => DEVICE_ID,
    dataSpaceDeviceId: async () => DEVICE_ID,
  });
  host.ctx.provide('secrets', { backup: createBackupCrypto() });
  host.ctx.provide('nativeCompression', compression);
  host.ctx.provide('backup', unused('backup'));
  host.ctx.provide('syncProvider', unused('syncProvider'));
  host.ctx.provide('vfsDatabase', { isInMaintenanceMode: () => false });
  await host.install(vfsRepos);
  await host.install(notes);
  await host.install(syncSupport);
  await host.install(review);
  await host.install(sync);
}, 180_000);

afterAll(async () => {
  await host?.dispose();
  (sourceStorage as StorageService & { dispose(): void } | undefined)?.dispose();
  (targetStorage as StorageService & { dispose(): void } | undefined)?.dispose();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe('sync real flow smoke', () => {
  it('real_vfs_note_roundtrips_without_pending_echo', () => {
    const source = sourceStorage.database('vfs');
    const target = targetStorage.database('vfs');
    clearChangeLog(source);
    clearChangeLog(target);

    insertVfsNoteBundle(source, 'res_real_flow_1', 'note_real_flow_1', 'hash_real_flow_1', 'Real migrated note');
    const pending = host.ctx.sync.getPendingChanges(source, null, null);
    expect(pending.total_count).toBeGreaterThanOrEqual(2);
    expect(pending.changes_by_table.resources).toBe(1);
    expect(pending.changes_by_table.notes).toBe(1);

    const changes = reverseForFkStress(cloudChanges(source, 'vfs'));
    const applied = host.ctx.sync.applyDownloadedChanges(target, changes, { deviceId: DEVICE_ID });
    expect(applied.success_count).toBeGreaterThanOrEqual(2);
    expect(applied.failure_count).toBe(0);

    expect(target.pluck("SELECT title FROM notes WHERE id='note_real_flow_1'"))
      .toBe('Real migrated note');
    expect(target.pluck("SELECT hash FROM resources WHERE id='res_real_flow_1'"))
      .toBe('hash_real_flow_1');
    expect(pendingCount(target)).toBe(0);

    const changeIds = pending.entries.map(entry => entry.id);
    expect(host.ctx.sync.markSyncedWithTimestamp(source, changeIds)).toBe(changeIds.length);
    expect(pendingCount(source)).toBe(0);
  }, 60_000);

  it('real_chat_fk_chain_roundtrips_without_pending_echo', () => {
    const source = sourceStorage.database('chat_v2');
    const target = targetStorage.database('chat_v2');
    clearChangeLog(source);
    clearChangeLog(target);

    insertChatBundle(source);
    const pending = host.ctx.sync.getPendingChanges(source, null, null);
    expect(pending.total_count).toBeGreaterThanOrEqual(4);
    for (const table of ['chat_v2_sessions', 'chat_v2_messages', 'chat_v2_blocks', 'chat_v2_attachments']) {
      expect(pending.changes_by_table[table]).toBe(1);
    }

    const changes = reverseForFkStress(cloudChanges(source, 'chat_v2'));
    const applied = host.ctx.sync.applyDownloadedChanges(target, changes, { deviceId: DEVICE_ID });
    expect(applied.success_count).toBeGreaterThanOrEqual(4);
    expect(applied.failure_count).toBe(0);

    expect(target.pluck("SELECT content FROM chat_v2_blocks WHERE id='blk_real_1'"))
      .toBe('streamed content');
    expect(target.pluck("SELECT storage_path FROM chat_v2_attachments WHERE id='att_real_1'"))
      .toBe('active/documents/scan.pdf');
    expect(pendingCount(target)).toBe(0);
  }, 60_000);

  it('real_llm_usage_daily_is_derived_and_legacy_pending_entries_are_filtered', () => {
    const usage = sourceStorage.database('llm_usage');
    clearChangeLog(usage);
    usage.run(
      `INSERT INTO llm_usage_daily (
         date, caller_type, model, provider, request_count, total_tokens
       ) VALUES ('2024-04-24','chat_v2','gpt-4o-mini','openai',1,150)`,
    );
    expect(pendingCount(usage)).toBe(0);

    usage.run(
      `INSERT INTO __change_log (table_name, record_id, operation)
       VALUES ('llm_usage_daily', '{"date":"2024-04-24","caller_type":"chat_v2","model":"gpt-4o-mini","provider":"openai"}', 'UPDATE')`,
    );
    const ts = '2024-04-24T12:34:56.000Z';
    usage.run(
      `INSERT INTO llm_usage_logs (
         id, timestamp, provider, model, adapter, api_config_id, prompt_tokens,
         completion_tokens, total_tokens, reasoning_tokens, cached_tokens, token_source,
         duration_ms, request_bytes, response_bytes, first_token_ms, caller_type,
         session_id, status, error_message, cost_estimate, updated_at
       ) VALUES ('usage_all',?1,'openai','gpt-4o-mini','openai_compatible','cfg_all',
         100,50,150,10,5,'api',1200,512,1024,300,'chat_v2','sess_all','success',NULL,0.0123,?1)`,
      [ts],
    );

    const raw = host.ctx.sync.getPendingChanges(usage, null, null);
    expect(raw.changes_by_table.llm_usage_daily).toBeDefined();
    expect(raw.changes_by_table.llm_usage_logs).toBeDefined();

    const filtered = host.ctx.sync.filterPendingChangesForDatabase(raw, 'llm_usage');
    expect(filtered.total_count).toBe(1);
    expect(filtered.changes_by_table.llm_usage_logs).toBeDefined();
    expect(filtered.changes_by_table.llm_usage_daily).toBeUndefined();

    const enriched = host.ctx.sync.enrichChangesWithData(usage, filtered.entries, null);
    expect(enriched).toHaveLength(1);
    expect(enriched[0]?.table_name).toBe('llm_usage_logs');
  }, 60_000);

  it('real_restore_baseline_clears_old_changes_and_allows_new_delta', () => {
    const vfs = sourceStorage.database('vfs');
    clearChangeLog(vfs);
    insertVfsNoteBundle(vfs, 'res_restore_flow_1', 'note_restore_flow_1', 'hash_restore_flow_1', 'Before restore');
    const pendingBefore = pendingCount(vfs);
    expect(pendingBefore).toBeGreaterThanOrEqual(2);

    const [truncated] = host.ctx.sync.resetSyncBaselineAfterRestore(vfs);
    expect(truncated).toBeGreaterThanOrEqual(pendingBefore);
    expect(pendingCount(vfs)).toBe(0);

    vfs.run(
      "UPDATE notes SET title='After restore', updated_at=?1 WHERE id='note_restore_flow_1'",
      ['2024-04-25T00:00:00Z'],
    );
    const pendingAfter = host.ctx.sync.getPendingChanges(vfs, null, null);
    expect(pendingAfter.total_count).toBe(1);
    expect(pendingAfter.entries[0]?.table_name).toBe('notes');
    expect(pendingAfter.entries[0]?.record_id).toBe('note_restore_flow_1');
  }, 60_000);
});

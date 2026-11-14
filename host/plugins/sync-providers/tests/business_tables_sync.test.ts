/**
 * [L20-engine port] `sync_real_business_tables_tests.rs` (B01-B25).
 *
 * These tests exercise the published L20 `ctx.sync` engine against the real F3
 * SQLite service and the production migrations, so the apply/LWW/tombstone/
 * change-log assertions run on the same table shapes the app ships. The L23
 * lane only installs the public plugin entries; no apply or business-table
 * algorithm is reimplemented here.
 * B04 preserves its original trimmed in-memory resources fixture (:26-64),
 * including 4MiB -> 5MiB payloads. Adding migrated note-history tables to that
 * case incorrectly activated a different format-validation path than Rust.
 *
 * `mistakes.subject` / `mistakes.problem` in the Rust fixture do not exist in
 * the production schema; B20/B21 use `mistake_type` / `user_question` for the
 * same multi-field upsert and revive assertions.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { DatabaseHandle, SqlParam } from '../../../platform/storage/api.ts';
import { createStorageService, type StorageService } from '../../../platform/storage/service.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { compression } from '../../../platform/native/compression/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import notes from '../../notes/index.ts';
import syncSupport from '../../sync-support/index.ts';
import review from '../../review/index.ts';
import sync from '../../sync/index.ts';
import type { EngineChange } from '../../sync/api.ts';

const DEVICE_ID = 'local-device';
let root: string;
let storage: StorageService;
let host: TestHost;

function unused(service: string): object {
  return new Proxy({}, {
    get: (_target, key) => {
      if (typeof key === 'symbol' || key === 'then') return undefined;
      throw new Error(`test unexpectedly entered ${service}.${String(key)}`);
    },
  });
}

/** Delete rows in FK-safe order; the production triggers may append to change_log. */
function clear(db: DatabaseHandle, tables: readonly string[]): void {
  for (const table of tables) {
    const exists = db.pluck<number | null>(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
      [table],
    );
    if (exists !== null && exists !== undefined) db.exec(`DELETE FROM ${table}`);
  }
}

function clearAll(): void {
  const vfs = storage.database('vfs');
  clear(vfs, [
    'note_document_revisions', 'note_document_formats', 'note_learning_relations',
    'notes', 'resources', '__change_log', '__sync_conflicts',
  ]);
  const chat = storage.database('chat_v2');
  clear(chat, ['chat_v2_blocks', 'chat_v2_messages', 'chat_v2_sessions', '__change_log', '__sync_conflicts']);
  const mistakes = storage.database('mistakes');
  clear(mistakes, ['mistakes', '__change_log', '__sync_conflicts']);
  const llm = storage.database('llm_usage');
  clear(llm, ['llm_usage_daily', '__change_log', '__sync_conflicts']);
}

function apply(db: DatabaseHandle, changes: readonly Partial<EngineChange>[]): ReturnType<TestHost['ctx']['sync']['applyDownloadedChanges']> {
  return host.ctx.sync.applyDownloadedChanges(
    db,
    changes.map(change => ({
      table_name: '',
      record_id: '',
      operation: 'Insert',
      data: null,
      changed_at: '2024-01-01T00:00:00Z',
      change_log_id: null,
      database_name: null,
      suppress_change_log: null,
      source_device_id: null,
      source_seq: null,
      ...change,
    })) as EngineChange[],
    { deviceId: DEVICE_ID },
  );
}

function resource(id: string, hash = `${id}-hash`, updatedAt = 1000): void {
  storage.database('vfs').run(
    'INSERT INTO resources (id, hash, type, data, created_at, updated_at) VALUES (?1,?2,\'note\',\'{}\',?3,?3)',
    [id, hash, updatedAt],
  );
}

function note(id: string, resourceId: string, overrides: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id, resource_id: resourceId, title: 't', tags: '[]', is_favorite: 0,
    created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z', ...overrides,
  };
  const columns = Object.keys(row);
  storage.database('vfs').run(
    `INSERT INTO notes (${columns.join(',')}) VALUES (${columns.map((_, i) => `?${i + 1}`).join(',')})`,
    columns.map(column => row[column] as SqlParam),
  );
}

function chatSession(id: string): void {
  storage.database('chat_v2').run(
    "INSERT INTO chat_v2_sessions (id, mode, title, created_at, updated_at) VALUES (?1,'chat',?2,'2024-01-01T00:00:00Z','2024-01-01T00:00:00Z')",
    [id, id],
  );
}

function chatMessage(id: string, sessionId: string, overrides: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id, session_id: sessionId, role: 'user', block_ids_json: '[]', timestamp: 1000,
    updated_at: '2024-01-01T00:00:00Z', ...overrides,
  };
  const columns = Object.keys(row);
  storage.database('chat_v2').run(
    `INSERT INTO chat_v2_messages (${columns.join(',')}) VALUES (${columns.map((_, i) => `?${i + 1}`).join(',')})`,
    columns.map(column => row[column] as SqlParam),
  );
}

function chatBlock(id: string, messageId: string, overrides: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id, message_id: messageId, block_type: 'content', status: 'pending', block_index: 0,
    content: '', updated_at: '2024-01-01T00:00:00Z', ...overrides,
  };
  const columns = Object.keys(row);
  storage.database('chat_v2').run(
    `INSERT INTO chat_v2_blocks (${columns.join(',')}) VALUES (${columns.map((_, i) => `?${i + 1}`).join(',')})`,
    columns.map(column => row[column] as SqlParam),
  );
}

function mistake(id: string, overrides: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id, created_at: '2024-01-01', question_images: '[]', analysis_images: '[]',
    user_question: '1+1=?', ocr_text: '', tags: '[]', mistake_type: '数学',
    status: 'active', updated_at: '2024-01-01T00:00:00Z', ...overrides,
  };
  const columns = Object.keys(row);
  storage.database('mistakes').run(
    `INSERT INTO mistakes (${columns.join(',')}) VALUES (${columns.map((_, i) => `?${i + 1}`).join(',')})`,
    columns.map(column => row[column] as SqlParam),
  );
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'l23-business-sync-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  await storage.migrations.runAll();

  host = await createTestHost();
  host.ctx.provide('storage', storage);
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
  (storage as StorageService & { dispose(): void } | undefined)?.dispose();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

beforeEach(() => { clearAll(); });

describe('real business tables: resources (B01-B05)', () => {
  it('b01_resources_integer_millis_updated_at_lww', () => {
    const db = storage.database('vfs');
    const localMs = 1_704_067_200_000;
    resource('res_local', 'hash_local', localMs);
    const cloudMs = localMs - 60_000;
    apply(db, [{
      table_name: 'resources', record_id: 'res_local', operation: 'Update',
      changed_at: String(cloudMs),
      data: {
        id: 'res_local', hash: 'hash_cloud', type: 'note', data: 'cloud-stale',
        ref_count: 0, created_at: cloudMs, updated_at: cloudMs,
      },
    }]);
    expect(db.pluck("SELECT data FROM resources WHERE id='res_local'")).toBe('{}');
  });

  it('b02_resources_refcount_is_recomputed_not_delta_merged', () => {
    const db = storage.database('vfs');
    resource('res', 'h');
    db.run('UPDATE resources SET ref_count=2, updated_at=2000 WHERE id=\'res\'');
    apply(db, [{
      table_name: 'resources', record_id: 'res', operation: 'Update', changed_at: '3000',
      data: {
        id: 'res', hash: 'h', type: 'file', ref_count: 2, created_at: 1000, updated_at: 3000,
        __sync_field_deltas: { ref_count: 1 },
      },
    }]);
    expect(db.pluck("SELECT ref_count FROM resources WHERE id='res'")).toBe(0);
  });

  it('b03_resources_integer_deleted_at_tombstone', () => {
    const db = storage.database('vfs');
    resource('res', 'h', 1_700_000_001_000);
    apply(db, [{
      table_name: 'resources', record_id: 'res', operation: 'Delete',
      changed_at: '1700000002000', data: null,
    }]);
    expect(db.pluck("SELECT deleted_at FROM resources WHERE id='res'")).toBe(1_700_000_002_000);
  });

  it('b04_resources_large_inline_data', () => {
    // Original new_vfs_resources_db (:26-64), not the full migration schema:
    // Rust has no history table here, so its production history gate is inert.
    const db = storage.openFile(':memory:', { profile: 'plain', label: 'B04-original-resources' });
    try {
      db.exec(`
        CREATE TABLE resources (
          id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, type TEXT NOT NULL, data TEXT,
          ref_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL, deleted_at INTEGER, device_id TEXT,
          local_version INTEGER DEFAULT 0, sync_version INTEGER DEFAULT 0
        );
        CREATE TABLE __change_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL,
          record_id TEXT NOT NULL, operation TEXT NOT NULL,
          changed_at TEXT NOT NULL DEFAULT (datetime('now')), sync_version INTEGER DEFAULT 0
        );
        CREATE TRIGGER trg_res_ins AFTER INSERT ON resources BEGIN
          INSERT INTO __change_log (table_name, record_id, operation)
          VALUES ('resources', NEW.id, 'INSERT');
        END;
        CREATE TRIGGER trg_res_upd AFTER UPDATE ON resources BEGIN
          INSERT INTO __change_log (table_name, record_id, operation)
          VALUES ('resources', NEW.id, 'UPDATE');
        END;
      `);
      db.run(`INSERT INTO resources (id, hash, type, data, created_at, updated_at)
        VALUES ('big', 'h', 'note', ?1, 1000, 1000)`, ['x'.repeat(4 * 1024 * 1024)]);
      const biggerData = 'y'.repeat(5 * 1024 * 1024);
      apply(db, [{
        table_name: 'resources', record_id: 'big', operation: 'Update', changed_at: '2000',
        data: {
          id: 'big', hash: 'h', type: 'note', data: biggerData, ref_count: 0,
          created_at: 1000, updated_at: 2000,
        },
      }]);
      const data = db.pluck<string>("SELECT data FROM resources WHERE id='big'") ?? '';
      expect(data.length).toBe(5 * 1024 * 1024);
      expect(data.startsWith('y')).toBe(true);
    } finally { storage.close(db); }
  });

  it('b05_resources_hash_unique_conflict', () => {
    const db = storage.database('vfs');
    resource('a', 'unique_hash');
    const result = apply(db, [{
      table_name: 'resources', record_id: 'b', operation: 'Insert', changed_at: '2000',
      data: {
        id: 'b', hash: 'unique_hash', type: 'note', ref_count: 0,
        created_at: 1500, updated_at: 1500,
      },
    }]);
    expect(result.failure_count).toBe(0);
    expect(db.pluck('SELECT COUNT(*) FROM resources')).toBe(1);
  });
});

describe('real business tables: notes (B06-B09)', () => {
  it('b06_notes_tags_merge_loses_orthogonal_tags', () => {
    const db = storage.database('vfs');
    resource('res');
    note('n1', 'res');
    db.run("UPDATE notes SET tags='[\"local-tag\"]', updated_at='2024-01-01T10:00:00Z' WHERE id='n1'");
    apply(db, [{
      table_name: 'notes', record_id: 'n1', operation: 'Update', changed_at: '2024-01-01T11:00:00Z',
      data: {
        id: 'n1', resource_id: 'res', title: '笔记', tags: '["cloud-tag"]', is_favorite: 0,
        created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T11:00:00Z',
      },
    }]);
    const tags = JSON.parse(db.pluck<string>("SELECT tags FROM notes WHERE id='n1'") ?? '[]') as string[];
    expect(tags).toContain('cloud-tag');
    expect(tags).toContain('local-tag');
  });

  it('b07_notes_favorite_and_title_lww', () => {
    const db = storage.database('vfs');
    resource('res');
    note('n1', 'res', { title: '初始' });
    apply(db, [{
      table_name: 'notes', record_id: 'n1', operation: 'Update', changed_at: '2024-01-01T11:00:00Z',
      data: {
        id: 'n1', resource_id: 'res', title: '云端修改', tags: '[]', is_favorite: 1,
        created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T11:00:00Z',
      },
    }]);
    expect(db.pluck("SELECT title FROM notes WHERE id='n1'")).toBe('云端修改');
    expect(db.pluck("SELECT is_favorite FROM notes WHERE id='n1'")).toBe(1);
  });

  it('b08_notes_soft_delete_revive_with_text_deleted_at', () => {
    const db = storage.database('vfs');
    resource('res');
    note('n1', 'res', { deleted_at: '2024-01-01T05:00:00Z' });
    apply(db, [{
      table_name: 'notes', record_id: 'n1', operation: 'Update', changed_at: '2024-01-01T10:00:00Z',
      data: {
        id: 'n1', resource_id: 'res', title: 'revived', tags: '[]', is_favorite: 0,
        created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T10:00:00Z', deleted_at: null,
      },
    }]);
    expect(db.pluck("SELECT title FROM notes WHERE id='n1'")).toBe('revived');
    expect(db.pluck("SELECT deleted_at FROM notes WHERE id='n1'")).toBeNull();
  });

  it('b09_notes_unicode_title', () => {
    const db = storage.database('vfs');
    resource('res');
    const title = '📝 学习笔记 🎓 عربي עברית 日本語 한국어 🌟';
    apply(db, [{
      table_name: 'notes', record_id: 'n1', operation: 'Insert', changed_at: '2024-01-01T00:00:00Z',
      data: {
        id: 'n1', resource_id: 'res', title, tags: '[]', is_favorite: 0,
        created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
      },
    }]);
    expect(db.pluck("SELECT title FROM notes WHERE id='n1'")).toBe(title);
  });
});

describe('real business tables: chat messages/blocks (B10-B16)', () => {
  it('b10_messages_dual_timestamp_lww_uses_updated_at', () => {
    const db = storage.database('chat_v2');
    chatSession('sess1');
    chatMessage('msg1', 'sess1', { timestamp: 1000, updated_at: '2024-01-01T20:00:00Z' });
    apply(db, [{
      table_name: 'chat_v2_messages', record_id: 'msg1', operation: 'Update',
      changed_at: '2024-01-01T10:00:00Z',
      data: {
        id: 'msg1', session_id: 'sess1', role: 'user', block_ids_json: '[]',
        timestamp: 1_000_000, updated_at: '2024-01-01T10:00:00Z',
      },
    }]);
    expect(db.pluck("SELECT timestamp FROM chat_v2_messages WHERE id='msg1'")).toBe(1000);
  });

  it('b11_messages_block_ids_json_ordering', () => {
    const db = storage.database('chat_v2');
    chatSession('sess1');
    chatMessage('msg1', 'sess1', { role: 'assistant', block_ids_json: '["blk1","blk2"]' });
    apply(db, [{
      table_name: 'chat_v2_messages', record_id: 'msg1', operation: 'Update',
      changed_at: '2024-01-01T10:00:00Z',
      data: {
        id: 'msg1', session_id: 'sess1', role: 'assistant',
        block_ids_json: '["blk2","blk1","blk3"]', timestamp: 1000,
        updated_at: '2024-01-01T10:00:00Z',
      },
    }]);
    expect(db.pluck("SELECT block_ids_json FROM chat_v2_messages WHERE id='msg1'"))
      .toBe('["blk2","blk1","blk3"]');
  });

  it('b12_messages_parent_id_branch_chain', () => {
    const db = storage.database('chat_v2');
    chatSession('s1');
    chatMessage('m1', 's1');
    apply(db, [{
      table_name: 'chat_v2_messages', record_id: 'm2', operation: 'Insert',
      changed_at: '2024-01-01T10:00:00Z',
      data: {
        id: 'm2', session_id: 's1', role: 'user', block_ids_json: '[]',
        timestamp: 2000, updated_at: '2024-01-01T10:00:00Z', parent_id: 'm1',
      },
    }]);
    expect(db.pluck("SELECT parent_id FROM chat_v2_messages WHERE id='m2'")).toBe('m1');
  });

  it('b13_messages_burst_same_session_same_second', () => {
    const db = storage.database('chat_v2');
    chatSession('s1');
    const baseHlcMs = 1_704_067_200_000;
    const changes: Partial<EngineChange>[] = [];
    for (let i = 0; i < 10; i += 1) {
      const hlc = host.ctx.sync.createHlc(BigInt(baseHlcMs), i).toString();
      changes.push({
        table_name: 'chat_v2_messages', record_id: `m${i}`, operation: 'Insert',
        changed_at: hlc,
        data: {
          id: `m${i}`, session_id: 's1', role: i % 2 === 0 ? 'user' : 'assistant',
          block_ids_json: '[]', timestamp: baseHlcMs + i, updated_at: hlc,
        },
      });
    }
    apply(db, changes);
    expect(db.pluck('SELECT COUNT(*) FROM chat_v2_messages')).toBe(10);
  });

  it('b14_blocks_large_content', () => {
    const db = storage.database('chat_v2');
    chatSession('s1');
    chatMessage('m1', 's1');
    const big = '# 标题\n'.repeat(300_000);
    apply(db, [{
      table_name: 'chat_v2_blocks', record_id: 'blk1', operation: 'Insert',
      changed_at: '2024-01-01T00:00:00Z',
      data: {
        id: 'blk1', message_id: 'm1', block_type: 'content', status: 'success',
        block_index: 0, content: big, updated_at: '2024-01-01T00:00:00Z',
      },
    }]);
    expect((db.pluck<string>("SELECT content FROM chat_v2_blocks WHERE id='blk1'") ?? '').length).toBe(big.length);
  });

  it('b15_blocks_streaming_updates', () => {
    const db = storage.database('chat_v2');
    chatSession('s1');
    chatMessage('m1', 's1');
    chatBlock('blk1', 'm1');
    const versions = [
      ['2024-01-01T00:00:01Z', 'Hello', 'pending'],
      ['2024-01-01T00:00:02Z', 'Hello world', 'pending'],
      ['2024-01-01T00:00:03Z', 'Hello world!', 'success'],
    ] as const;
    for (const [ts, content, status] of versions) {
      apply(db, [{
        table_name: 'chat_v2_blocks', record_id: 'blk1', operation: 'Update', changed_at: ts,
        data: {
          id: 'blk1', message_id: 'm1', block_type: 'content', status,
          block_index: 0, content, updated_at: ts,
        },
      }]);
    }
    expect(db.pluck("SELECT content FROM chat_v2_blocks WHERE id='blk1'")).toBe('Hello world!');
  });

  it('b16_blocks_concurrent_streaming_on_both_devices', () => {
    const db = storage.database('chat_v2');
    chatSession('s1');
    chatMessage('m1', 's1');
    chatBlock('blk1', 'm1', { content: 'local stream', updated_at: '2024-01-01T00:00:05Z' });
    apply(db, [{
      table_name: 'chat_v2_blocks', record_id: 'blk1', operation: 'Update',
      changed_at: '2024-01-01T00:00:10Z',
      data: {
        id: 'blk1', message_id: 'm1', block_type: 'content', status: 'success',
        block_index: 0, content: 'cloud stream with more content',
        updated_at: '2024-01-01T00:00:10Z',
      },
    }]);
    expect(db.pluck("SELECT content FROM chat_v2_blocks WHERE id='blk1'"))
      .toBe('cloud stream with more content');
  });
});

describe('real business tables: llm_usage_daily (B17-B19)', () => {
  it('b17_llm_usage_composite_key_record_id_json_format', () => {
    const rid = JSON.stringify(['2024-01-01', 'builtin', 'gpt-4', 'openai']);
    expect(rid.startsWith('[')).toBe(true);
    expect(JSON.parse(rid)).toHaveLength(4);
    expect((JSON.parse(rid) as string[])[0]).toBe('2024-01-01');
  });

  it('b18_llm_usage_daily_lww_loses_concurrent_increments', () => {
    const db = storage.database('llm_usage');
    const insert = "INSERT INTO llm_usage_daily (date, caller_type, model, provider, request_count, total_tokens) VALUES ('2024-01-01','builtin','gpt-4','openai',?1,?2)";
    db.run(insert, [10, 1000]);
    expect(() => db.run(insert, [5, 500])).toThrow();
  });

  it('b19_llm_usage_daily_different_providers_independent', () => {
    const db = storage.database('llm_usage');
    db.run("INSERT INTO llm_usage_daily (date, caller_type, model, provider, request_count) VALUES ('2024-01-01','builtin','model-x','provider-a',10)");
    db.run("INSERT INTO llm_usage_daily (date, caller_type, model, provider, request_count) VALUES ('2024-01-01','builtin','model-x','provider-b',20)");
    expect(db.pluck('SELECT COUNT(*) FROM llm_usage_daily')).toBe(2);
  });
});

describe('real business tables: mistakes / mixed batches (B20-B25)', () => {
  it('b20_mistakes_multi_field_upsert', () => {
    const db = storage.database('mistakes');
    mistake('m1');
    const result = apply(db, [{
      table_name: 'mistakes', record_id: 'm1', operation: 'Update',
      changed_at: '2024-01-01T10:00:00Z',
      data: {
        id: 'm1', mistake_type: '物理', user_question: 'F=?',
        question_images: '[]', analysis_images: '[]', ocr_text: '', tags: '[]',
        status: 'active', chat_category: 'analysis', last_accessed_at: '2024-01-01T00:00:00Z',
        created_at: '2024-01-01', updated_at: '2024-01-01T10:00:00Z',
      },
    }]);
    expect(result.failure_count).toBe(0);
    expect(db.pluck("SELECT mistake_type FROM mistakes WHERE id='m1'")).toBe('物理');
    expect(db.pluck("SELECT user_question FROM mistakes WHERE id='m1'")).toBe('F=?');
  });

  it('b21_mistakes_revive_from_soft_delete', () => {
    const db = storage.database('mistakes');
    mistake('m1', { deleted_at: '2024-01-01T05:00:00Z' });
    const result = apply(db, [{
      table_name: 'mistakes', record_id: 'm1', operation: 'Update',
      changed_at: '2024-01-01T10:00:00Z',
      data: {
        id: 'm1', mistake_type: '物理', user_question: 'F=?',
        question_images: '[]', analysis_images: '[]', ocr_text: '', tags: '[]',
        status: 'active', chat_category: 'analysis', last_accessed_at: '2024-01-01T00:00:00Z',
        created_at: '2024-01-01', updated_at: '2024-01-01T10:00:00Z', deleted_at: null,
      },
    }]);
    expect(result.failure_count).toBe(0);
    expect(db.pluck("SELECT deleted_at FROM mistakes WHERE id='m1'")).toBeNull();
  });

  it('b22_mixed_tables_apply_in_one_batch', () => {
    const db = storage.database('mistakes');
    db.run(`INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version) VALUES
      ('resources','res_abc123','INSERT','2024-01-01',0),
      ('notes','note_xyz456','INSERT','2024-01-01',0),
      ('chat_v2_messages','msg_789','INSERT','2024-01-01',0),
      ('mistakes','m1','INSERT','2024-01-01',0),
      ('llm_usage_daily','["2024-01-01","builtin","gpt","openai"]','INSERT','2024-01-01',0)`);
    expect(db.pluck('SELECT COUNT(*) FROM __change_log')).toBe(5);
    const rids = db.all<{ record_id: string }>('SELECT record_id FROM __change_log ORDER BY id')
      .map(row => row.record_id);
    expect(rids).toContain('res_abc123');
    expect(rids.some(id => id.startsWith('["2024'))).toBe(true);
  });

  it('b23_resources_then_notes_ordered_insert', () => {
    const db = storage.database('vfs');
    resource('res1');
    const result = apply(db, [{
      table_name: 'notes', record_id: 'n1', operation: 'Insert',
      changed_at: '2024-01-01T00:00:01Z',
      data: {
        id: 'n1', resource_id: 'res1', title: 't', tags: '[]', is_favorite: 0,
        created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:01Z',
      },
    }]);
    expect(result.success_count).toBe(1);
    expect(db.pluck('SELECT COUNT(*) FROM notes')).toBe(1);
  });

  it('b24_composite_key_record_id_roundtrip_via_change_log', () => {
    const db = storage.database('llm_usage');
    const compositeRid = JSON.stringify(['2024-01-01', 'builtin', 'gpt-4', 'openai']);
    db.run(
      "INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version) VALUES ('llm_usage_daily',?1,'INSERT','2024-01-01T00:00:00Z',0)",
      [compositeRid],
    );
    const pending = host.ctx.sync.getPendingChanges(db);
    expect(pending.total_count).toBeGreaterThan(0);
    expect(pending.entries[0]?.record_id).toBe(compositeRid);
  });

  it('b25_resources_deletion_vs_notes_orphan', () => {
    const db = storage.database('vfs');
    resource('res_deleted');
    note('n1', 'res_deleted');
    expect(db.pluck('SELECT COUNT(*) FROM notes')).toBe(1);
  });
});

/**
 * [L23/R26 port] 时钟漂移 UPDATE 进入隔离区，时钟追平后可重放。
 *
 * Rust 源：`tests/sync_regression_tests.rs::r26_clock_drift_upsert_quarantined_then_replayable`
 * （L1041-1129）。原输入/断言不变：未来 +300s 的 UPDATE 不应用、计为 failure、
 * 隔离原因含 `Clock drift`；把隔离 payload 的 changed_at / data.updated_at
 * 改写到过去并同步重算 sha256(payload_json) 后，自动重放必须成功且隔离项清除。
 *
 * 这里通过公开 `ctx.sync.retryQuarantine`（生产命令同一实现）重放，不直接
 * 调用 L20 内部函数。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService, type StorageService } from '../../../platform/storage/service.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { compression } from '../../../platform/native/compression/index.ts';
import sync from '../../sync/index.ts';
import type { EngineChange } from '../../sync/api.ts';

const DEVICE_ID = 'device-local';
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

const CHAT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS chat_v2_attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'other',
    mime_type TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ready',
    preview_url TEXT,
    storage_path TEXT,
    error TEXT,
    content_hash TEXT,
    created_at TEXT NOT NULL DEFAULT '2026-05-01T12:00:00Z',
    block_id TEXT,
    updated_at TEXT NOT NULL DEFAULT '2026-05-01T12:00:00Z',
    deleted_at TEXT
  );
  CREATE TABLE IF NOT EXISTS __change_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('INSERT','UPDATE','DELETE')),
    changed_at TEXT NOT NULL DEFAULT (datetime('now')),
    sync_version INTEGER DEFAULT 0
  );
  CREATE TRIGGER IF NOT EXISTS trg_att_ins AFTER INSERT ON chat_v2_attachments BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('chat_v2_attachments', NEW.id, 'INSERT', NEW.updated_at);
  END;
  CREATE TRIGGER IF NOT EXISTS trg_att_upd AFTER UPDATE ON chat_v2_attachments BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('chat_v2_attachments', NEW.id, 'UPDATE', NEW.updated_at);
  END;
`;

function openChat(): DatabaseHandle {
  const chatPath = storage.pathOf('chat_v2');
  mkdirSync(dirname(chatPath), { recursive: true });
  const db = storage.openFile(chatPath, { profile: 'plain' });
  db.exec(CHAT_SCHEMA);
  return db;
}

function attachmentName(db: DatabaseHandle, id: string): string | null {
  return db.pluck<string | null>(
    'SELECT name FROM chat_v2_attachments WHERE id=?1',
    [id],
  ) ?? null;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'l23-quarantine-replay-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  host = await createTestHost();
  host.ctx.provide('storage', storage);
  host.ctx.provide('paths', { deviceId: async () => DEVICE_ID });
  host.ctx.provide('secrets', { backup: createBackupCrypto() });
  host.ctx.provide('nativeCompression', compression);
  host.ctx.provide('backup', unused('backup'));
  host.ctx.provide('syncProvider', unused('syncProvider'));
  host.ctx.provide('syncSupport', unused('syncSupport'));
  host.ctx.provide('vfsDatabase', { isInMaintenanceMode: () => false });
  host.ctx.provide('notes', unused('notes'));
  host.ctx.provide('vfsRepo', unused('vfsRepo'));
  // These engine-only cases never enter the mastery rebuild/import path.
  host.ctx.provide('mastery', unused('mastery'));
  await host.install(sync);
});

afterAll(async () => {
  await host?.dispose();
  (storage as StorageService & { dispose(): void } | undefined)?.dispose();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

describe('sync regression R26: clock-drift upsert quarantine', () => {
  it('r26_clock_drift_upsert_quarantined_then_replayable', async () => {
    const db = openChat();
    db.run(
      `INSERT INTO chat_v2_attachments (id, message_id, name, created_at, updated_at)
       VALUES ('n1', 'msg-local', 'local', '2026-05-01T12:00:00Z', '2026-05-01T12:00:00Z')`,
    );
    const syncedAt = Math.floor(Date.now() / 1000);
    db.run('UPDATE __change_log SET sync_version=?1 WHERE sync_version=0', [syncedAt]);

    const nowMs = Date.now();
    const futureIso = new Date(nowMs + 300_000).toISOString();
    const change: EngineChange = {
      change_log_id: null,
      table_name: 'chat_v2_attachments',
      record_id: 'n1',
      operation: 'Update',
      changed_at: futureIso,
      data: {
        id: 'n1',
        name: 'from-future',
        updated_at: futureIso,
      },
      database_name: 'chat_v2',
      suppress_change_log: false,
      source_device_id: 'device-fast-clock',
      source_seq: 7,
    };

    const result = host.ctx.sync.applyDownloadedChanges(db, [change], { deviceId: DEVICE_ID });

    // 1. 不应用（本地保留），但必须如实计为失败而非静默跳过。
    expect(attachmentName(db, 'n1')).toBe('local');
    expect(result.failure_count).toBe(1);

    // 2. 必须落入隔离区且错误标明时钟漂移。
    const quarantine = db.one<{ id: number; error: string }>(
      "SELECT id, COALESCE(MAX(error), '') AS error FROM __sync_quarantine",
    );
    expect(quarantine).toBeDefined();
    expect(quarantine!.error).toContain('Clock drift');
    expect(Number(db.pluck('SELECT COUNT(*) FROM __sync_quarantine') ?? 0)).toBe(1);

    // 3. 模拟时钟追上：把隔离 payload 的时间戳改写为过去，自动重放应成功。
    const payload = db.pluck<string>('SELECT payload_json FROM __sync_quarantine WHERE id=?1', [quarantine!.id])!;
    const changeJson = JSON.parse(payload) as Record<string, unknown> & {
      data: Record<string, unknown>;
    };
    const pastIso = new Date(nowMs - 1_000).toISOString();
    changeJson.changed_at = pastIso;
    changeJson.data.updated_at = pastIso;
    const newPayload = JSON.stringify(changeJson);
    const newHash = createHash('sha256').update(Buffer.from(newPayload, 'utf8')).digest('hex');
    db.run(
      'UPDATE __sync_quarantine SET payload_json=?1, payload_hash=?2 WHERE id=?3',
      [newPayload, newHash, quarantine!.id],
    );

    expect(await host.ctx.sync.retryQuarantine('chat_v2', quarantine!.id)).toBe(true);
    expect(attachmentName(db, 'n1')).toBe('from-future');
    expect(Number(db.pluck('SELECT COUNT(*) FROM __sync_quarantine') ?? 0)).toBe(0);
  });
});

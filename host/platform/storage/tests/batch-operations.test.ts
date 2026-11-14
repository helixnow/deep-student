/**
 * `dstu-storage/src/batch_operations.rs`（无 Rust 测试）的行为验证：
 * `batch_archive_old_mistakes` 与 `batch_cleanup_orphaned_messages` 走生产
 * `StorageServiceImpl`（mistakes 库、deferred 事务），断言与 Rust SQL 语义一致。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorageService, type StorageServiceImpl } from '../service.ts';

let dir: string;
let storage: StorageServiceImpl;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f3-batch-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  const report = await storage.migrations.runAll();
  expect(report.success).toBe(true);
}, 60_000);

afterEach(() => {
  storage.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

function insertMistake(id: string, createdAt: string, status: string): void {
  storage.database('mistakes').run(
    `INSERT INTO mistakes
       (id, created_at, question_images, analysis_images, user_question, ocr_text,
        tags, mistake_type, status, chat_category, updated_at, last_accessed_at)
     VALUES (?1, ?2, '[]', '[]', ?1, '', '[]', 'analysis', ?3, 'analysis', ?2, '1970-01-01T00:00:00Z')`,
    [id, createdAt, status],
  );
}

describe('dstu-storage batch_operations', () => {
  it('batch_archive_old_mistakes archives only old non-archived rows and refreshes access time', () => {
    const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();
    insertMistake('old-active', daysAgo(100), 'completed');
    insertMistake('old-archived', daysAgo(100), 'archived');
    insertMistake('new-active', daysAgo(10), 'completed');
    const archivedBefore = storage.database('mistakes').get<{ updated_at: string }>(
      "SELECT updated_at FROM mistakes WHERE id = 'old-archived'",
    );

    expect(storage.batchArchiveOldMistakes(30)).toBe(1);

    const db = storage.database('mistakes');
    expect(db.pluck<string>("SELECT status FROM mistakes WHERE id = 'old-active'")).toBe('archived');
    expect(db.pluck<string>("SELECT last_accessed_at FROM mistakes WHERE id = 'old-active'"))
      .toBe(db.pluck<string>("SELECT updated_at FROM mistakes WHERE id = 'old-active'"));
    expect(db.pluck<string>("SELECT last_accessed_at FROM mistakes WHERE id = 'old-active'"))
      .not.toBe('1970-01-01T00:00:00Z');
    expect(db.pluck<string>("SELECT updated_at FROM mistakes WHERE id = 'old-archived'"))
      .toBe(archivedBefore!.updated_at);
    expect(db.pluck<string>("SELECT status FROM mistakes WHERE id = 'new-active'")).toBe('completed');
  });

  it('batch_cleanup_orphaned_messages removes only rows whose mistake no longer exists', () => {
    insertMistake('live-mistake', new Date().toISOString(), 'completed');
    const db = storage.database('mistakes');
    db.exec('PRAGMA foreign_keys = OFF');
    db.run(
      "INSERT INTO chat_messages (mistake_id, role, content, timestamp) VALUES ('live-mistake', 'user', 'kept', '2026-01-01T00:00:00+00:00')",
    );
    db.run(
      "INSERT INTO chat_messages (mistake_id, role, content, timestamp) VALUES ('gone-mistake', 'user', 'orphan', '2026-01-01T00:00:00+00:00')",
    );
    db.exec('PRAGMA foreign_keys = ON');

    expect(storage.batchCleanupOrphanedMessages()).toBe(1);
    expect(db.all<{ mistake_id: string }>('SELECT mistake_id FROM chat_messages')).toEqual([
      { mistake_id: 'live-mistake' },
    ]);
  });
});

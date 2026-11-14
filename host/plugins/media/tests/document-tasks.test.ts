import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import media from '../index.ts';
import { documentTaskStatus } from '../src/document-tasks.ts';

let template: string;
beforeAll(async () => {
  template = fs.mkdtempSync(path.join(os.tmpdir(), 'media-document-tasks-'));
  const source = createStorageService({ baseDir: template, dataLocalDir: template });
  try {
    const report = await source.migrations.runAll();
    expect(report.success, report.error ?? '').toBe(true);
  } finally { source.dispose(); }
}, 120_000);
afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);

it('get_recent_document_tasks reads the main database and maps statuses', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-document-tasks-run-'));
  fs.cpSync(template, root, { recursive: true });
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const db = storage.database('mistakes');
  const insert = (id: string, status: string, updatedAt: string, deletedAt: string | null): void => {
    db.run(
      `INSERT INTO document_tasks
         (id, document_id, original_document_name, segment_index, content_segment,
          status, created_at, updated_at, error_message, anki_generation_options_json, deleted_at)
       VALUES (?1, 'doc_1', 'notes.pdf', 0, 'segment', ?2, '2026-01-01T00:00:00Z', ?3, NULL, '{}', ?4)`,
      [id, status, updatedAt, deletedAt],
    );
  };
  insert('task_old', 'Completed', '2026-01-01T00:00:00Z', null);
  insert('task_new', 'Streaming', '2026-03-01T00:00:00Z', null);
  insert('task_mid', 'Paused', '2026-02-01T00:00:00Z', null);
  insert('task_deleted', 'Failed', '2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z');

  const host = await createTestHost({
    plugins: [media],
    provide: {
      settings: { get: () => null, save: () => undefined },
      storage: { database: (name: string) => storage.database(name as 'mistakes') },
      paths: { appDataDir: root },
    },
  });
  try {
    const tasks = await host.invoke('get_recent_document_tasks', {}) as Array<{
      id: string; status: string; document_id: string; segment_index: number;
    }>;
    expect(tasks.map(task => task.id)).toEqual(['task_new', 'task_mid', 'task_old']);
    expect(tasks.map(task => task.status)).toEqual(['Streaming', 'Paused', 'Completed']);
    expect(tasks[0]).toMatchObject({ document_id: 'doc_1', segment_index: 0 });
    expect((await host.invoke('get_recent_document_tasks', { limit: 1 }) as unknown[]).length).toBe(1);
  } finally {
    await host.dispose();
    storage.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('documentTaskStatus falls back to Pending for unknown values', () => {
  expect(documentTaskStatus('Cancelled')).toBe('Cancelled');
  expect(documentTaskStatus('Truncated')).toBe('Truncated');
  expect(documentTaskStatus('pending')).toBe('Pending');
  expect(documentTaskStatus('')).toBe('Pending');
});

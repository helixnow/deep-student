/**
 * V04-06：`lib.rs:3770-3780` 在 build_app_state 中同步调用 `anki_database.recover_stuck_document_tasks()`
 * （`database/mod.rs:7389-7427`，阈值 10 分钟）：卡住的任务改为 Paused，失败只记 warn。
 * 手动命令 `recover_stuck_document_tasks` 保持不变（见 anki-db.test.ts）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import {
  ANKI_STARTUP_RECOVERY_FINALIZER, recoverStuckDocumentTasksAtStartup, registerAnkiStartupRecovery,
} from '../src/startup-recovery.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';
import anki from '../index.ts';

const PAUSED_MESSAGE = '任务被中断（应用重启），可点击恢复继续';

let env: AnkiTestEnv;
let db: DatabaseHandle;
beforeEach(async () => {
  env = await createAnkiTestEnv({ migrationScope: ['mistakes'] });
  db = env.storage.database('mistakes');
});
afterEach(async () => { await env.dispose(); });

function insertTask(id: string, documentId: string, status: string, minutesAgo: number): void {
  db.run(
    `INSERT INTO document_tasks
       (id, document_id, original_document_name, segment_index, content_segment,
        status, created_at, updated_at, error_message, anki_generation_options_json,
        source_session_id, deleted_at)
     VALUES (?1, ?2, 'doc.md', 0, 'segment', ?3,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ?4 || ' minutes'),
       NULL, '{}', NULL, NULL)`,
    [id, documentId, status, minutesAgo],
  );
}
function task(id: string) {
  return db.one<{ status: string; error_message: string | null }>(
    'SELECT status, error_message FROM document_tasks WHERE id = ?1', [id]);
}
function recordingLog() {
  const lines: string[] = [];
  return {
    lines,
    log: {
      info: (message: string) => { lines.push(`info ${message}`); },
      warn: (message: string) => { lines.push(`warn ${message}`); },
    },
  };
}

describe('V04-06 anki startup recovery (lib.rs:3770-3780)', () => {
  it('a storage without the finalizer API leaves plugin apply intact and only warns', () => {
    const warns: string[] = [];
    const ctx = { logger: () => ({ info() {}, warn: (message: string) => { warns.push(message); } }), storage: {} };
    expect(() => registerAnkiStartupRecovery(ctx as never)).not.toThrow();
    expect(warns).toEqual([expect.stringContaining('[AppSetup] Anki startup recovery finalizer not registered:')]);
  });

  it('a startup finalizer pauses tasks idle for more than 10 minutes and leaves recent ones', async () => {
    insertTask('stuck-processing', 'doc-1', 'Processing', 11);
    insertTask('stuck-streaming', 'doc-2', 'Streaming', 30);
    insertTask('recent-processing', 'doc-3', 'Processing', 5);
    insertTask('done', 'doc-4', 'Completed', 60);

    expect(env.storage.finalizerNames()).toContain(ANKI_STARTUP_RECOVERY_FINALIZER);
    await env.storage.runStartupFinalizers();

    expect(task('stuck-processing')).toEqual({ status: 'Paused', error_message: PAUSED_MESSAGE });
    expect(task('stuck-streaming')).toEqual({ status: 'Paused', error_message: PAUSED_MESSAGE });
    expect(task('recent-processing')).toEqual({ status: 'Processing', error_message: null });
    expect(task('done')).toEqual({ status: 'Completed', error_message: null });
  });

  it('logs the Rust info line only when tasks were recovered', () => {
    insertTask('stuck', 'doc-1', 'Processing', 15);
    const { lines, log } = recordingLog();
    expect(recoverStuckDocumentTasksAtStartup(() => db, log)).toBe(1);
    expect(recoverStuckDocumentTasksAtStartup(() => db, log)).toBe(0);
    expect(lines).toEqual(['info [AppSetup] Recovered 1 stuck Anki document tasks']);
  });

  it('V09-P1-3: an unload before startup withdraws the finalizer; a reinstall after startup does not pause running tasks', async () => {
    const own = await createAnkiTestEnv({ migrationScope: ['mistakes'], withReview: false });
    try {
      const ownDb = own.storage.database('mistakes');
      const insert = (id: string, minutesAgo: number) => ownDb.run(
        `INSERT INTO document_tasks
           (id, document_id, original_document_name, segment_index, content_segment,
            status, created_at, updated_at, error_message, anki_generation_options_json,
            source_session_id, deleted_at)
         VALUES (?1, ?1, 'doc.md', 0, 'segment', 'Processing',
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'),
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ?2 || ' minutes'),
           NULL, '{}', NULL, NULL)`, [id, minutesAgo]);
      const status = (id: string) => ownDb.one<{ status: string }>('SELECT status FROM document_tasks WHERE id = ?1', [id]).status;
      const registered = () => own.storage.finalizerNames().filter(name => name === ANKI_STARTUP_RECOVERY_FINALIZER);

      await own.host.unload('dstu.anki');
      expect(registered()).toEqual([]);
      await own.host.install(anki);
      expect(registered()).toEqual([ANKI_STARTUP_RECOVERY_FINALIZER]);
      insert('stuck-before-start', 30);
      await own.storage.runStartupFinalizers();
      expect(status('stuck-before-start')).toBe('Paused');

      insert('idle-after-start', 30);
      await own.host.unload('dstu.anki');
      await own.host.install(anki);
      expect(own.host.plugins.map(plugin => plugin.id)).toContain('dstu.anki');
      expect(status('idle-after-start')).toBe('Processing');
    } finally {
      await own.dispose();
    }
  });

  it('a failing recovery only warns, so the startup finalizer chain still completes', async () => {
    const { lines, log } = recordingLog();
    expect(recoverStuckDocumentTasksAtStartup(() => { throw new Error('database is locked'); }, log)).toBe(0);
    expect(lines).toEqual(['warn [AppSetup] Failed to recover stuck Anki tasks: database is locked']);

    db.exec('DROP TABLE document_tasks');
    await expect(env.storage.runStartupFinalizers()).resolves.toMatchObject({
      completed: expect.arrayContaining([ANKI_STARTUP_RECOVERY_FINALIZER]),
    });
  });
});

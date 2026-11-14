import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import { createSettingsService } from '../../../platform/settings/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import vfsPlugin from '../../vfs/index.ts';
import vfsReposPlugin from '../../vfs-repos/index.ts';
import notesPlugin from '../../notes/index.ts';
import vfsIndexPlugin from '../../vfs-index/index.ts';
import mediaPlugin from '../../media/index.ts';
import vfsHandlersPlugin from '../../vfs-handlers/index.ts';
import memoryPlugin from '../index.ts';
import type { MemoryWriteOutput } from '../api.ts';
import type { SmartWriteOutput } from '../api.ts';
import { createMemoryDecisionDouble } from './support.ts';
import { createMigratedMemoryStorage } from './fixtures/migrated-schema.ts';

let cleanup: (() => Promise<void> | void) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

async function setupRealOwners(infos: string[] = [], decision?: () => string): Promise<{
  host: TestHost; db: ReturnType<ReturnType<typeof createStorageService>['database']>;
}> {
  const { dir, storage, report } = await createMigratedMemoryStorage('memory-note-owner-');
  cleanup = () => { storage.dispose(); rmSync(dir, { recursive: true, force: true }); };
  expect(report.success).toBe(true);
  const settings = createSettingsService({
    db: () => storage.database('mistakes'),
    secureStore: () => null,
    secrets: { isSensitiveKey: () => false },
  });
  const host = await createTestHost({
    plugins: [pathsPlugin, vfsReposPlugin, notesPlugin, vfsIndexPlugin, vfsPlugin,
      mediaPlugin, vfsHandlersPlugin, memoryPlugin],
    provide: {
      storage, settings,
      ...(decision === undefined ? {} : { llmRawPrompt: createMemoryDecisionDouble(decision) }),
      log: {
        logger: (target: string) => ({
          target, error: () => undefined, warn: () => undefined,
          info: (message: string) => { infos.push(message); },
          debug: () => undefined, trace: () => undefined,
        }),
        write: () => undefined,
      },
    },
    app: { dataDir: dir },
  });
  const storageCleanup = cleanup;
  cleanup = async () => { await host.dispose(); storageCleanup(); };
  return { host, db: storage.database('vfs') };
}

describe('memory note access through the real L10 notes owner', () => {
  it('memory_get_tags uses the L10 decoder and warns on malformed or mixed tags', async () => {
    const warnings: string[] = [];
    const { host, db } = await setupRealOwners();
    // L10 binds ctx.logger('notes'), not the separate F4 ctx.log service.
    host.ctx.logger.exporter({ levels: { notes: 2 }, export: message => {
      if (message.name === 'notes' && message.type === 'warn') {
        warnings.push(message.args.map(String).join(' '));
      }
    } });
    const note = await host.invoke('memory_write', { title: 'Tags owner', content: '用户偏好' }) as MemoryWriteOutput;
    for (const tags of ['["valid",7]', '{bad json']) {
      db.run('UPDATE notes SET tags=?1 WHERE id=?2', [tags, note.noteId]);
      const warningsBefore = warnings.length;
      expect(await host.invoke('memory_get_tags', { noteId: note.noteId })).toEqual([]);
      expect(warnings.slice(warningsBefore).some(message => message.includes(
        `[VFS::NoteRepo] Failed to parse tags JSON for note ${note.noteId}`))).toBe(true);
    }
  });

  // Rust memory reads use `VfsNoteRepo::get_note_content(..)?` (service.rs:974 and others):
  // a live note whose resource row is missing is an error (note_repo.rs:1012-1031), not "".
  it('memory_read propagates the missing-resource error instead of returning empty content', async () => {
    const { host, db } = await setupRealOwners();
    const written = await host.invoke('memory_write', {
      title: 'Content owner', content: 'owned by notes',
    }) as MemoryWriteOutput;
    expect(await host.invoke('memory_read', { noteId: written.noteId }))
      .toMatchObject({ content: 'owned by notes' });

    db.run('PRAGMA foreign_keys = OFF');
    db.run('DELETE FROM resources WHERE id = ?1', [written.resourceId]);
    db.run('PRAGMA foreign_keys = ON');

    await expect(host.invoke('memory_read', { noteId: written.noteId }))
      .rejects.toThrow(`Missing resource for note ${written.noteId}`);
  });

  // X6-SW-MEM-01 / R5-M2, Rust service.rs:3495-3532: deleting a memory strips incoming
  // `_ref:` tags through the tags-only owner write (updated_at untouched) and logs info.
  it('memory_delete removes incoming refs via L10 tags-only seam without touching updated_at', async () => {
    const infos: string[] = [];
    const { host, db } = await setupRealOwners(infos);
    const a = await host.invoke('memory_write', { title: 'Ref A', content: 'a' }) as MemoryWriteOutput;
    const b = await host.invoke('memory_write', { title: 'Ref B', content: 'b' }) as MemoryWriteOutput;
    await host.invoke('memory_add_relation', { noteIdA: a.noteId, noteIdB: b.noteId });
    const before = db.get<{ tags: string; updatedAt: string }>(
      'SELECT tags, updated_at AS updatedAt FROM notes WHERE id = ?1', [b.noteId])!;
    expect(JSON.parse(before.tags)).toContain(`_ref:${a.noteId}`);

    await host.invoke('memory_delete', { noteId: a.noteId });

    const after = db.get<{ tags: string; updatedAt: string }>(
      'SELECT tags, updated_at AS updatedAt FROM notes WHERE id = ?1', [b.noteId])!;
    expect(JSON.parse(after.tags)).not.toContain(`_ref:${a.noteId}`);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(infos).toContain(
      `[Memory] Removed dangling _ref tags pointing to ${a.noteId} from 1 notes`);
  });

  // R5-M1: real L10/L11 owners, mutation + receipt on one transaction. Only the remote
  // model/retrieval boundary is supplied by a test provider; the note/index writes are real.
  it('fact DELETE replacement rolls back both notes and index purge if its receipt fails', async () => {
    let target = '';
    const { host, db } = await setupRealOwners([], () => JSON.stringify({
      event: 'DELETE', target_note_id: target, confidence: 0.9, reason: '偏好改变',
    }));
    const original = await host.invoke('memory_write', { title: '旧偏好', content: '我偏好列表' }) as MemoryWriteOutput;
    target = original.noteId;
    db.run(`INSERT INTO vfs_index_units
      (id,resource_id,unit_index,text_content,text_source,text_required,text_state,
       mm_required,mm_state,created_at,updated_at)
      VALUES ('unit_delete_replace',?1,1,'我偏好图解','native',1,'pending',0,'disabled',1,1)`,
    [original.resourceId]);
    db.run(`CREATE TRIGGER fail_fact_receipt BEFORE UPDATE OF event ON memory_write_idempotency
      BEGIN SELECT RAISE(ABORT, 'fact receipt interrupted'); END`);
    await expect(host.invoke('memory_write_smart', { title: '新偏好', content: '我偏好图解',
      memoryType: 'fact', idempotencyKey: 'replace-atomic' }))
      .rejects.toThrow('fact receipt interrupted');
    expect(await host.invoke('memory_read', { noteId: target })).toMatchObject({ content: '我偏好列表' });
    expect(db.pluck<number>("SELECT COUNT(*) FROM vfs_index_units WHERE id='unit_delete_replace'")).toBe(1);
    expect(db.pluck<number>("SELECT COUNT(*) FROM notes WHERE title='新偏好'")).toBe(0);
    db.run('DROP TRIGGER fail_fact_receipt');
    const output = await host.invoke('memory_write_smart', { title: '新偏好', content: '我偏好图解',
      memoryType: 'fact', idempotencyKey: 'replace-atomic' }) as SmartWriteOutput;
    expect(output.event).toBe('DELETE');
    expect(output.isNew).toBe(true);
    expect(await host.invoke('memory_read', { noteId: target })).toBeNull();
    expect(await host.invoke('memory_read', { noteId: output.noteId })).toMatchObject({ content: '我偏好图解' });
    expect(db.pluck<number>("SELECT COUNT(*) FROM vfs_index_units WHERE id='unit_delete_replace'")).toBe(0);
    expect(db.get<{ noteId: string; event: string }>(
      "SELECT note_id AS noteId,event FROM memory_write_idempotency WHERE idempotency_key='replace-atomic'"))
      .toMatchObject({ noteId: output.noteId, event: 'DELETE' });
  });
});

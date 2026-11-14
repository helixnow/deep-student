import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentServices, ExecutionContext, type AgentToolCall } from '../../../kernel/agent-api.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import paths from '../../../platform/paths/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { defineQuery } from '../../../platform/storage/api.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import notes from '../index.ts';
import { noteLeaseRepository } from '../repository/leases.ts';
import { noteRelationRepository } from '../repository/relations.ts';
import { notesLog } from '../repository/log.ts';
import { buildZip } from './zip-fixture.ts';

type Host = Awaited<ReturnType<typeof createTestHost>>;
let host: Host;
let storage: ReturnType<typeof createStorageService>;

beforeAll(async () => {
  host = await createTestHost();
  storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  await storage.migrations.runAll();
  host.ctx.provide('storage', storage);
  host.ctx.provide('settings', createSettingsStore({
    db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
  }));
  // Real owner services, not createNotesTestRepos: the calls below must exercise
  // the installed production plugin and its actual resource/todo repositories.
  await host.install(paths, vfsRepos, notes);
}, 120000);

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await host.dispose();
  storage.dispose();
});

function context(call: AgentToolCall): ExecutionContext {
  return new ExecutionContext({
    call,
    ids: { sessionId: 'v2', messageId: 'v2', toolCallId: call.id, round: 0 },
    emitter: { hasFrontend: () => false, emitBlockEvent() {}, emitSessionEvent() {} },
    services: new AgentServices(),
    host: {
      hasFrontend: () => false, emit() {},
      async roundTrip() { throw new Error('headless'); }, asAny: () => null,
    },
    runtimeRoots: {
      tempRoot: () => join(storage.locations.activeDir, 'v2-staged'),
      artifactRoot: () => storage.locations.activeDir,
      workspaceRoot: () => storage.locations.activeDir,
      resolve: (path) => join(storage.locations.activeDir, path), authorize() {},
    },
    blockStore: { upsertToolBlock() {} },
    dispatcher: { async dispatchAdmitted() { throw new Error('no nested call'); } },
    cancel: new AbortController().signal,
  });
}

describe('L10-V2-02 notes_get_subject_rag_config serde boundary', () => {
  const fallback = { chunk_size: 512, chunk_overlap: 50, min_chunk_size: 20, rerank_enabled: true };

  it.each([
    '{"chunk_size":512.5,"chunk_overlap":50,"min_chunk_size":20,"rerank_enabled":true}',
    '{"chunk_size":600.0,"chunk_overlap":50,"min_chunk_size":20,"rerank_enabled":true}',
    '{"chunk_size":6e2,"chunk_overlap":50,"min_chunk_size":20,"rerank_enabled":true}',
    '{"chunk_size":2147483648,"chunk_overlap":50,"min_chunk_size":20,"rerank_enabled":true}',
    '{"chunk_size":-2147483649,"chunk_overlap":50,"min_chunk_size":20,"rerank_enabled":true}',
    '{"chunk_size":512,"chunk_overlap":-0.1,"min_chunk_size":20,"rerank_enabled":true}',
    '{"chunk_size":512,"chunk_overlap":50,"min_chunk_size":20.1,"rerank_enabled":true}',
    '{"chunk_size":512,"chunk_overlap":50,"min_chunk_size":20,"rerank_enabled":1}',
    '{"chunk_size":512,"chunk_overlap":50,"min_chunk_size":20}',
    '{"chunk_size":null,"chunk_overlap":50,"min_chunk_size":20,"rerank_enabled":true}',
    '{"chunk_size":100,"chunk_size":600,"chunk_overlap":50,"min_chunk_size":20,"rerank_enabled":true}',
    '[600,30,10,true,0]',
    '[600,30,10]',
    'null',
    '{',
  ])('falls back on invalid persisted NotesSubjectRagConfig: %s', async (raw) => {
    // Rust cmd/notes.rs:2236-2257: failed serde decode is ignored, then defaults.
    host.ctx.settings.save('notes.rag.config.invalid', raw);
    expect(await host.invoke('notes_get_subject_rag_config', { subject: 'invalid' })).toEqual(fallback);
    expect(host.ctx.settings.get('notes.rag.config.invalid')).toBe(raw);
  });

  it.each([
    '{"chunk_size":-2147483648,"chunk_overlap":2147483647,"min_chunk_size":0,"rerank_enabled":false,"extra":{"chunk_size":1}}',
    '[-2147483648,2147483647,0,false]',
  ])('accepts i32 endpoints, unknown fields and serde struct sequence form: %s', async (raw) => {
    // The GET decoder does not apply UPDATE's business constraints.
    host.ctx.settings.save('notes.rag.config.valid', raw);
    expect(await host.invoke('notes_get_subject_rag_config', { subject: 'valid' })).toEqual({
      chunk_size: -2147483648, chunk_overlap: 2147483647, min_chunk_size: 0, rerank_enabled: false,
    });
  });
});

describe('L10-V2-03 Rust Instant.elapsed through notes.tools', () => {
  it.each(['canvas', 'userTodo', 'notesImport'] as const)('%s failure ignores wall-clock rollback and floors monotonic milliseconds', async (tool) => {
    const call = {
      id: `time-${tool}`, name: tool === 'canvas' ? 'builtin-note_read'
        : tool === 'userTodo' ? 'builtin-user_todo_create_item' : 'builtin-notes_import',
      arguments: {},
    };
    const ctx = context(call);
    vi.spyOn(Date, 'now').mockReturnValueOnce(10_000).mockReturnValue(-10_000);
    vi.spyOn(performance, 'now').mockReturnValueOnce(100.25).mockReturnValue(109.99);
    const result = await host.ctx.notes.tools![tool].execute(call, ctx);
    expect(result.success).toBe(false);
    expect(result.durationMs).toBe(9);
    expect(Number.isInteger(result.durationMs)).toBe(true);
  });

  it.each(['canvas', 'userTodo', 'notesImport'] as const)('%s success uses monotonic whole milliseconds', async (tool) => {
    const root = join(storage.locations.activeDir, 'v2-staged');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'import.zip'), buildZip([{
      name: 'note.md', bytes: Buffer.from('# Monotonic import\n\nbody'),
    }]));
    const call = {
      id: `time-success-${tool}`, name: tool === 'canvas' ? 'builtin-note_list'
        : tool === 'userTodo' ? 'builtin-user_todo_list_lists' : 'builtin-notes_import',
      arguments: tool === 'notesImport' ? { relative_path: 'import.zip' } : {},
    };
    const ctx = context(call);
    vi.spyOn(Date, 'now').mockReturnValue(0);
    vi.spyOn(performance, 'now').mockReturnValueOnce(50.125).mockReturnValue(57.875);
    const result = await host.ctx.notes.tools![tool].execute(call, ctx);
    expect(result.success).toBe(true);
    expect(result.durationMs).toBe(7);
    expect(Number.isInteger(result.durationMs)).toBe(true);
  });
});

describe('L17 seam notes.repository.rewriteTagsWithoutTouchingUpdatedAtWithConn', () => {
  it('rewrites only tags on the caller transaction, including trashed rows, and propagates SQL errors', async () => {
    const repo = host.ctx.notes.repository;
    const db = storage.database('vfs');
    const live = await host.invoke<{ id: string }>('notes_create', {
      note: { title: 'tag seam live', content_md: 'body', tags: ['a', '_ref:x'] },
    });
    const trashed = await host.invoke<{ id: string }>('notes_create', {
      note: { title: 'tag seam trashed', content_md: 'body', tags: ['b'] },
    });
    await host.invoke('notes_delete', { id: trashed.id });
    const before = (id: string) => db.one<Record<string, unknown>>(
      'SELECT tags, updated_at, resource_id, deleted_at FROM notes WHERE id=?1', [id]);
    const liveBefore = before(live.id);
    const trashedBefore = before(trashed.id);
    const revisionsBefore = db.pluck<number>('SELECT COUNT(*) FROM note_document_revisions');

    // Rust service.rs:3518 / 4416: the UPDATE runs inside the caller's BEGIN.
    db.transaction(() => {
      repo.rewriteTagsWithoutTouchingUpdatedAtWithConn!(db, live.id, '["a"]');
      repo.rewriteTagsWithoutTouchingUpdatedAtWithConn!(db, trashed.id, '["b","_stale"]');
    });
    expect(before(live.id)).toEqual({ ...liveBefore, tags: '["a"]' });
    expect(before(trashed.id)).toEqual({ ...trashedBefore, tags: '["b","_stale"]' });
    expect(db.pluck<number>('SELECT COUNT(*) FROM note_document_revisions')).toBe(revisionsBefore);

    // Rolled-back caller transaction keeps the previous value.
    expect(() => db.transaction(() => {
      repo.rewriteTagsWithoutTouchingUpdatedAtWithConn!(db, live.id, '["rolled back"]');
      throw new Error('caller abort');
    })).toThrow('caller abort');
    expect(before(live.id).tags).toBe('["a"]');

    // Missing id is a 0-row UPDATE (Rust ignores the count); SQL errors surface.
    expect(() => repo.rewriteTagsWithoutTouchingUpdatedAtWithConn!(db, 'note_missing', '[]')).not.toThrow();
    db.exec("CREATE TRIGGER fail_tags BEFORE UPDATE OF tags ON notes BEGIN SELECT RAISE(ABORT,'tags blocked'); END");
    try {
      expect(() => repo.rewriteTagsWithoutTouchingUpdatedAtWithConn!(db, live.id, '[]')).toThrow('tags blocked');
    } finally {
      db.exec('DROP TRIGGER fail_tags');
    }
  });

  it('getNoteContent keeps note_repo.rs:1022-1030 missing-resource Database error', async () => {
    const note = await host.invoke<{ id: string }>('notes_create', {
      note: { title: 'missing resource', content_md: 'body' },
    });
    const db = storage.database('vfs');
    db.exec('PRAGMA foreign_keys=OFF');
    try {
      db.run("UPDATE notes SET resource_id='res_gone' WHERE id=?1", [note.id]);
      expect(() => host.ctx.notes.repository.getNoteContent(note.id, db))
        .toThrow(`Missing resource for note ${note.id}`);
      // No self-heal: Rust only warns and returns Err, the row is unchanged.
      expect(db.pluck<string>('SELECT resource_id FROM notes WHERE id=?1', [note.id])).toBe('res_gone');
    } finally {
      db.exec('PRAGMA foreign_keys=ON');
    }
  });
});

describe('L13 seam notes.leases.authorized (note_lease_repo.rs:307-361)', () => {
  const key = (work: () => unknown): string => {
    try {
      work();
    } catch (error) {
      return (error as { key?: string }).key ?? String(error);
    }
    throw new Error('expected a lease conflict');
  };

  it('runs work behind the grant, refreshes frozen drafts on commit and rolls back with original keys', async () => {
    const leases = host.ctx.notes.leases!;
    const repo = host.ctx.notes.repository;
    const db = storage.database('vfs');
    const created = await host.invoke<{ id: string }>('notes_create', {
      note: { title: 'lease seam', content_md: 'Before' },
    });
    const note = repo.getNote(created.id, db)!;
    const owner = noteLeaseRepository.register(db, note.id, 'a', 'a', 100).participant_id;
    const lease = noteLeaseRepository.begin(db, owner, 'a', 'op', [note.id], 100);
    const auth = { participant_id: owner, token: lease.token };
    const grants = () => db.pluck<number>('SELECT COUNT(*) FROM note_editor_write_grants');

    // Pending barrier: direct writes fence, authorized refuses until ready.
    expect(key(() => leases.checkWrite(db, note.id))).toBe('notes.lease_conflict');
    expect(key(() => leases.authorized(db, auth, 'a', 100, true, () => undefined))).toBe('notes.lease_not_ready');
    noteLeaseRepository.ack(db, auth, 'a', { markdown: 'Before', expected_updated_at: note.updatedAt }, 100);
    expect(key(() => leases.authorized(db, auth, 'b', 100, true, () => undefined))).toBe('notes.participant_expired');
    expect(key(() => leases.authorized(db, { ...auth, participant_id: 'p_other' }, 'a', 100, true, () => undefined)))
      .toBe('notes.participant_expired');

    // Work failure rolls back the body write and the grant, and is rethrown as-is.
    const failure = new Error('work failed');
    expect(() => leases.authorized(db, auth, 'a', 100, true, () => {
      repo.updateNote(note.id, { content: 'Rolled back', expectedUpdatedAt: note.updatedAt }, db);
      throw failure;
    })).toThrow(failure);
    expect(repo.getNoteContent(note.id, db)).toBe('Before');
    expect(grants()).toBe(0);

    const updated = leases.authorized(db, auth, 'a', 100, true, () => {
      leases.checkWrite(db, note.id);
      return repo.updateNote(note.id, { content: 'Committed', expectedUpdatedAt: note.updatedAt }, db);
    });
    expect(repo.getNoteContent(note.id, db)).toBe('Committed');
    expect(grants()).toBe(0);
    const frozen = db.pluck<string>('SELECT draft_json FROM note_editor_lease_acks WHERE token=?1', [auth.token]);
    expect(frozen).toBe(JSON.stringify({ markdown: 'Committed', expected_updated_at: updated.updatedAt }));
    expect(key(() => leases.checkWrite(db, note.id))).toBe('notes.lease_conflict');

    // A frozen draft that no longer matches the live document blocks commit, not flush-free work.
    db.run('UPDATE note_editor_lease_acks SET draft_json=?2 WHERE token=?1',
      [auth.token, JSON.stringify({ markdown: 'Stale', expected_updated_at: updated.updatedAt })]);
    expect(key(() => leases.authorized(db, auth, 'a', 100, true, () => undefined))).toBe('notes.lease_flush_required');
    expect(leases.authorized(db, auth, 'a', 100, false, () => 'no commit')).toBe('no commit');
    expect(key(() => leases.authorized(db, auth, 'a', 200, false, () => undefined))).toBe('notes.participant_expired');
  });
});

describe('X6-LP-0228 create/update savepoint errors match note_repo.rs', () => {
  it.each(['create', 'update'] as const)('%s RELEASE failure logs and returns without body-failure rollback', async (operation) => {
    const db = storage.database('vfs');
    const original = await host.invoke<{ id: string; updated_at: string }>('notes_create', {
      note: { title: 'LP before', content_md: 'body' },
    });
    const before = db.pluck<number>('SELECT COUNT(*) FROM notes');
    const errorLog = vi.spyOn(notesLog, 'error');
    const statement = operation === 'create' ? 'INSERT' : 'UPDATE OF title';
    const command = operation === 'create' ? 'notes_create' : 'notes_update';
    const args = operation === 'create'
      ? { note: { title: 'LP after', content_md: 'body' } }
      : { note: { id: original.id, title: 'LP after', expected_updated_at: original.updated_at } };
    db.exec(`CREATE TABLE lp_parent(id TEXT PRIMARY KEY);
      CREATE TABLE lp_child(id TEXT REFERENCES lp_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER lp_deferred AFTER ${statement} ON notes BEGIN INSERT INTO lp_child VALUES('missing'); END;`);
    try {
      await expect(host.invoke(command, args)).rejects.toMatchObject({
        error_type: 'Database',
        message: `VFS ${operation === 'create' ? '创建' : '更新'}笔记失败: Database error: Failed to release savepoint: FOREIGN KEY constraint failed`,
      });
      expect(errorLog).toHaveBeenCalledWith(
        `[VFS::NoteRepo] Failed to release savepoint ${operation}_note: FOREIGN KEY constraint failed`);
      // Rust returns the RELEASE error via `?`; it does not enter the body-error
      // branch, so the failed commit remains open until its caller rolls back.
      expect(db.inTransaction).toBe(true);
      expect(db.pluck<number>('SELECT COUNT(*) FROM notes')).toBe(operation === 'create' ? before! + 1 : before);
      if (operation === 'update') {
        expect(db.pluck<string>('SELECT title FROM notes WHERE id=?1', [original.id])).toBe('LP after');
      }
    } finally {
      if (db.inTransaction) db.exec('ROLLBACK');
      db.exec('DROP TRIGGER lp_deferred; DROP TABLE lp_child; DROP TABLE lp_parent;');
    }
    expect(db.pluck<number>('SELECT COUNT(*) FROM notes')).toBe(before);
    expect(host.ctx.notes.repository.getNote(original.id, db)!.title).toBe('LP before');
    await expect(host.invoke(command, args)).resolves.toMatchObject({ title: 'LP after' });
  });
});

describe('N2 notes_db_vacuum / notes_list_tags run off the Host thread (spawn_blocking)', () => {
  it('uses the F3 worker connection, not the main vfs handle, and keeps the command results', async () => {
    const main = storage.database('vfs');
    await host.invoke('notes_create', { note: { title: 'worker tags', content_md: 'b', tags: ['wk-a', 'wk-b'] } });
    await host.invoke('notes_create', { note: { title: 'worker tags 2', content_md: 'b', tags: ['wk-a'] } });
    const execSpy = vi.spyOn(main, 'exec');
    const allSpy = vi.spyOn(main, 'all');

    expect(await host.invoke('notes_db_vacuum', {})).toBe(true);
    const tags = await host.invoke<string[]>('notes_list_tags', {});
    expect(tags.indexOf('wk-a')).toBeGreaterThanOrEqual(0);
    expect(tags.indexOf('wk-a')).toBeLessThan(tags.indexOf('wk-b'));

    expect(execSpy.mock.calls.some(([sql]) => /VACUUM/i.test(String(sql)))).toBe(false);
    expect(allSpy.mock.calls.some(([sql]) => /note_tags/.test(String(typeof sql === 'string' ? sql : (sql as { sql: string }).sql))))
      .toBe(false);
  });
});

describe('F3-V2-05 notes.deletionJournal owner SQL (file_deletion_queue.rs)', () => {
  it('asset intents: insert/duplicate tuple, ordered recovery list, cancel and ready on the caller connection', () => {
    const journal = host.ctx.notes.deletionJournal!;
    const vfs = storage.database('vfs');
    const base = {
      targetKind: 'asset' as const, entityKey: 'active/notes_assets/_global/n/a.png',
      localPath: 'notes_assets/_global/n/a.png', expectedHash: 'h1', size: 18_446_744_073_709_551_615n,
    };
    const first = journal.insertPreparedIntent(vfs, { ...base, operationId: 'op-b' })!;
    expect(first).toEqual({
      operation_id: 'op-b', entity_key: base.entityKey, local_path: base.localPath, expected_hash: 'h1',
      size: 18_446_744_073_709_551_615n,
    });
    // Rust `size as i64` stores u64::MAX as -1; the same tuple is idempotent, a different one is a duplicate.
    const exactSize = defineQuery<readonly [string], { size: bigint }>(
      'SELECT size FROM __file_deletion_journal WHERE operation_id=?1', { options: { safeIntegers: true } });
    expect(vfs.get(exactSize, ['op-b'])!.size).toBe(-1n);
    expect(journal.insertPreparedIntent(vfs, { ...base, operationId: 'op-b' })).toEqual(first);
    expect(journal.insertPreparedIntent(vfs, { ...base, operationId: 'op-b', expectedHash: 'other' })).toBeNull();
    journal.insertPreparedIntent(vfs, { ...base, operationId: 'op-a', size: 9_007_199_254_740_993n });
    journal.insertPreparedIntent(vfs, { ...base, operationId: 'op-c', expectedHash: null, size: null });
    vfs.run("UPDATE __file_deletion_journal SET prepared_at='2000-01-01T00:00:00+00:00' WHERE operation_id IN ('op-a','op-b','op-c')");

    // u64::try_from(-1) fails, so the recovered size is None.
    expect(journal.listPreparedIntents(vfs, 'asset').filter((i) => i.operation_id.startsWith('op-'))).toEqual([
      expect.objectContaining({ operation_id: 'op-a', size: 9_007_199_254_740_993n }),
      expect.objectContaining({ operation_id: 'op-b', size: null }),
      expect.objectContaining({ operation_id: 'op-c', expected_hash: null, size: null }),
    ]);

    journal.cancelRetainedIntent(vfs, 'op-c');
    journal.cancelConflictIntent(vfs, 'op-b', 'file content changed after prepare: expected=h1, actual=h2');
    const row = (id: string) => vfs.get<{ state: string; last_error: string | null; cancelled_at: string | null }>(
      'SELECT state, last_error, cancelled_at FROM __file_deletion_journal WHERE operation_id=?1', [id])!;
    expect(row('op-c')).toMatchObject({ state: 'cancelled', last_error: 'retained by note history/current document' });
    expect(row('op-b')).toMatchObject({ state: 'cancelled', last_error: 'file content changed after prepare: expected=h1, actual=h2' });
    expect(row('op-b').cancelled_at).toMatch(/\+00:00$/);

    const ready = journal.listPreparedIntents(vfs, 'asset').find((i) => i.operation_id === 'op-a')!;
    expect(journal.markReady(vfs, 'asset', ready)).toBe(true);
    expect(row('op-a')).toMatchObject({ state: 'ready', last_error: null });
    const queued = defineQuery<readonly [string], { size: bigint; retry_count: bigint }>(
      'SELECT size, retry_count FROM __asset_deletion_queue WHERE key=?1', { options: { safeIntegers: true } });
    expect(vfs.get(queued, [base.entityKey])).toEqual({ size: 9_007_199_254_740_993n, retry_count: 0n });
    // A cancelled row cannot advance: the queue upsert is rolled back with the savepoint.
    vfs.run('DELETE FROM __asset_deletion_queue WHERE key=?1', [base.entityKey]);
    expect(journal.markReady(vfs, 'asset', { ...ready, operation_id: 'op-b' })).toBe(false);
    expect(vfs.get(queued, [base.entityKey])).toBeUndefined();
    expect(vfs.inTransaction).toBe(false);

    // SQL errors surface unchanged and roll the savepoint back.
    vfs.exec("CREATE TRIGGER fdj_block BEFORE UPDATE ON __file_deletion_journal BEGIN SELECT RAISE(ABORT,'journal blocked'); END");
    try {
      journal.insertPreparedIntent(vfs, { ...base, operationId: 'op-d', size: 1n });
      const d = journal.listPreparedIntents(vfs, 'asset').find((i) => i.operation_id === 'op-d')!;
      expect(() => journal.markReady(vfs, 'asset', d)).toThrow('journal blocked');
      expect(vfs.get(queued, [base.entityKey])).toBeUndefined();
      expect(vfs.inTransaction).toBe(false);
    } finally {
      vfs.exec('DROP TRIGGER fdj_block');
    }
  });

  it('workspace intents: ready queue then cancelReadyWorkspaceDeletion in one savepoint', () => {
    const journal = host.ctx.notes.deletionJournal!;
    const chat = storage.database('chat_v2');
    const intent = journal.insertPreparedIntent(chat, {
      operationId: 'ws-op', targetKind: 'workspace', entityKey: 'ws1', localPath: 'ws_ws1.db', expectedHash: null, size: 4096n,
    })!;
    expect(journal.markReady(chat, 'workspace', intent)).toBe(true);
    expect(chat.pluck<number>("SELECT COUNT(*) FROM __workspace_deletion_queue WHERE workspace_id='ws1'")).toBe(1);
    journal.cancelReadyWorkspaceDeletion(chat, 'ws1');
    expect(chat.get<{ state: string; last_error: string }>(
      "SELECT state, last_error FROM __file_deletion_journal WHERE operation_id='ws-op'")).toEqual({
      state: 'cancelled', last_error: 'workspace recreated before deletion was published',
    });
    expect(chat.pluck<number>("SELECT COUNT(*) FROM __workspace_deletion_queue WHERE workspace_id='ws1'")).toBe(0);
  });
});

describe('N5 folder membership deletes use the L11 owner on the same connection', () => {
  it('cleans orphan membership and preserves the missing-note result and caller rollback', () => {
    const db = storage.database('vfs');
    const folders = host.ctx.vfsRepo.folders;
    const remove = vi.spyOn(folders, 'removeItemByItemId');
    const add = () => folders.addItemToFolder(db, {
      id: 'fi_n5_orphan', itemType: 'note', itemId: 'note_n5_orphan', sortOrder: 0, createdAt: 1,
    });
    add();
    expect(() => db.transaction(() => {
      host.ctx.notes.repository.purgeNote('note_n5_orphan', db);
      throw new Error('caller abort');
    })).toThrow('caller abort');
    expect(folders.getFolderItemByItemId(db, 'note', 'note_n5_orphan')).not.toBeNull();
    host.ctx.notes.repository.purgeNote('note_n5_orphan', db);
    expect(remove).toHaveBeenCalledWith(db, 'note', 'note_n5_orphan');
    expect(folders.getFolderItemByItemId(db, 'note', 'note_n5_orphan')).toBeNull();
    expect(() => host.ctx.notes.repository.purgeNote('note_n5_orphan', db))
      .toThrow('Note not found: note_n5_orphan');
  });

  it('rolls owner membership deletion back when note deletion fails, then commits both on retry', () => {
    const db = storage.database('vfs');
    const folders = host.ctx.vfsRepo.folders;
    const remove = vi.spyOn(folders, 'removeItemByItemId');
    const note = host.ctx.notes.repository.createNoteInFolder({ title: 'N5 purge', content: 'body' }, null, db);
    db.exec("CREATE TRIGGER n5_block BEFORE DELETE ON notes BEGIN SELECT RAISE(ABORT,'note blocked'); END");
    try {
      db.exec("CREATE TRIGGER n5_folder_block BEFORE DELETE ON folder_items BEGIN SELECT RAISE(ABORT,'membership blocked'); END");
      try {
        // Owner errors still occur before note deletion, as in Rust's original
        // membership DELETE -> note DELETE sequence inside vfs_note_purge_tx.
        expect(() => host.ctx.notes.repository.purgeNote(note.id, db)).toThrow('Database error: membership blocked');
        expect(host.ctx.notes.repository.getNote(note.id, db)).not.toBeNull();
      } finally {
        db.exec('DROP TRIGGER n5_folder_block');
      }
      expect(() => host.ctx.notes.repository.purgeNote(note.id, db)).toThrow('note blocked');
      expect(remove).toHaveBeenCalledWith(db, 'note', note.id);
      expect(folders.getFolderItemByItemId(db, 'note', note.id)).not.toBeNull();
      expect(host.ctx.notes.repository.getNote(note.id, db)).not.toBeNull();
    } finally {
      db.exec('DROP TRIGGER n5_block');
    }
    host.ctx.notes.repository.purgeNote(note.id, db);
    expect(folders.getFolderItemByItemId(db, 'note', note.id)).toBeNull();
    expect(host.ctx.notes.repository.getNote(note.id, db)).toBeNull();
  });
});

describe('L10-V2-07 relation i64 CAS stays exact until the IPC boundary', () => {
  async function fixture() {
    const db = storage.database('vfs');
    const note = await host.invoke<{ id: string }>('notes_create', {
      note: { title: 'relation precision', content_md: 'body' },
    });
    const resourceId = host.ctx.notes.repository.getNote(note.id, db)!.resourceId;
    const request = {
      id: `rel-${note.id}`, note_id: note.id, block_id: null, type: 'source' as const,
      resource_id: resourceId, locator: { type: 'whole' as const },
    };
    await host.invoke('notes_relation_put', { request });
    return { db, request };
  }

  it.each([9_007_199_254_740_993n, -9_007_199_254_740_994n])('round-trips persisted revision %s through get/list/put/delete', async (revision) => {
    const { db, request } = await fixture();
    db.run('UPDATE note_learning_relations SET revision=?2 WHERE id=?1', [request.id, revision]);
    const current = noteRelationRepository.get(db, null, request.id)!;
    expect(current.revision).toBe(revision);
    expect(noteRelationRepository.list(db, null, request.note_id)).toEqual([current]);

    // D3: the frontend sees JSON numbers, as in Tauri; the repository must not
    // round its own CAS token just because that frontend representation rounds.
    expect(await host.invoke('notes_relation_get', { id: request.id })).toMatchObject({ revision: Number(revision) });
    expect(await host.invoke('notes_relation_list', { noteId: request.note_id }))
      .toEqual([expect.objectContaining({ revision: Number(revision) })]);
    if (revision === 9_007_199_254_740_993n) {
      // A frontend's already-rounded i64 is still a valid request: like Rust,
      // it conflicts with the stored revision, not a new unsafe-number validation error.
      await expect(host.invoke('notes_relation_put', {
        request: { ...request, expected_revision: Number(revision) },
      })).rejects.toMatchObject({ error_type: 'Conflict', message: expect.stringContaining('notes.relation_conflict') });
    }
    const neighbour = revision + 1n;
    expect(() => noteRelationRepository.put(db, null, { ...request, expected_revision: neighbour }))
      .toThrow(expect.objectContaining({ key: 'notes.relation_conflict' }));
    expect(() => noteRelationRepository.delete(db, request.id, neighbour))
      .toThrow(expect.objectContaining({ key: 'notes.relation_conflict' }));

    expect(() => db.transaction(() => {
      const updated = noteRelationRepository.put(db, null, { ...request, expected_revision: current.revision });
      expect(updated.revision).toBe(revision + 1n);
      throw new Error('caller abort');
    })).toThrow('caller abort');
    expect(noteRelationRepository.get(db, null, request.id)!.revision).toBe(revision);

    const updated = noteRelationRepository.put(db, null, { ...request, expected_revision: current.revision });
    expect(updated.revision).toBe(revision + 1n);
    expect(noteRelationRepository.delete(db, request.id, updated.revision)).toBe(true);
    expect(noteRelationRepository.get(db, null, request.id)).toBeNull();
  });

  it('preserves safe integer compatibility and rolls back SQLite REAL promotion on i64 overflow', async () => {
    const { db, request } = await fixture();
    for (const revision of [BigInt(Number.MIN_SAFE_INTEGER), 1n, BigInt(Number.MAX_SAFE_INTEGER)]) {
      db.run('UPDATE note_learning_relations SET revision=?2 WHERE id=?1', [request.id, revision]);
      expect(noteRelationRepository.get(db, null, request.id)!.revision).toBe(Number(revision));
    }
    const max = 9_223_372_036_854_775_807n;
    db.run('UPDATE note_learning_relations SET revision=?2 WHERE id=?1', [request.id, max]);
    // Rust leaves `revision=revision+1` in SQL, then get::<i64> rejects the REAL
    // result, rolling the savepoint back. Do not silently accept its JS number.
    expect(() => noteRelationRepository.put(db, null, { ...request, expected_revision: max }))
      .toThrow('Invalid column type Real at index: 6, name: revision');
    expect(noteRelationRepository.get(db, null, request.id)!.revision).toBe(max);
  });
});

describe('N1 notes.state exact i64 revision and serde_json::Value (arbitrary_precision)', () => {
  it('reads, CAS-writes and round-trips 2^53+1 values and revisions without Number rounding', async () => {
    const repo = host.ctx.notes.state;
    const db = storage.database('vfs');
    const note = await host.invoke<{ id: string }>('notes_create', { note: { title: 'state exact', content_md: 'b' } });
    const key = { note_id: note.id, type: 'review' as const, key: 'exact' };
    const created = repo.put(db, { ...key, value: { seed: 1 } });
    expect(created.revision).toBe(1);
    db.run("UPDATE note_state SET value_json=?2, revision=?3 WHERE note_id=?1 AND state_key='exact'",
      [note.id, '{"n":9007199254740993,"f":1.0,"neg":-9007199254740995}', 9_007_199_254_740_993n]);

    const exact = repo.get(db, key)!;
    expect(exact.revision).toBe(9_007_199_254_740_993n);
    const value = exact.value as Record<string, unknown>;
    expect(value.n).toBe(9_007_199_254_740_993n);
    expect(value.neg).toBe(-9_007_199_254_740_995n);

    // IPC: serde_json prints the exact numbers; the wire carries JSON numbers (D3).
    const wire = await host.invoke<{ revision: number; value: Record<string, unknown> }>('notes_state_get', { request: key });
    expect(wire.revision).toBe(Number(9_007_199_254_740_993n));
    expect(wire.value).toEqual({ n: Number(9_007_199_254_740_993n), f: 1, neg: Number(-9_007_199_254_740_995n) });

    // CAS compares the exact i64: the rounded neighbour conflicts.
    expect(() => repo.put(db, { ...key, expected_revision: 9_007_199_254_740_992n, value: null }))
      .toThrow(expect.objectContaining({ key: 'notes.state_conflict' }));
    const updated = repo.put(db, { ...key, expected_revision: 9_007_199_254_740_993n, value: exact.value });
    expect(updated.revision).toBe(9_007_199_254_740_994n);
    // Rust Value round-trip keeps the integer text and the float token 1.0.
    expect(db.pluck<string>("SELECT value_json FROM note_state WHERE note_id=?1 AND state_key='exact'", [note.id]))
      .toBe('{"n":9007199254740993,"f":1.0,"neg":-9007199254740995}');

    // note_state has CHECK(revision > 0); delete CAS still uses the exact value.
    const removed = repo.delete(db, { ...key, expected_revision: 9_007_199_254_740_994n });
    expect(removed).toMatchObject({ deleted: true, revision: 9_007_199_254_740_995n, value: null });
  });
});

describe('L20 s03 notes.sync.updateInferredFormat reads soft-deleted notes (note_history.rs:285-286)', () => {
  it('infers the format of a trashed note in the caller transaction and keeps plain reads filtered', async () => {
    const sync = host.ctx.notes.sync!;
    const db = storage.database('vfs');
    const note = await host.invoke<{ id: string }>('notes_create', {
      note: { title: 'tombstone format', content_md: '<!-- ds:block-id=b1 -->\n\nBlock body\n' },
    });
    await host.invoke('notes_delete', { id: note.id });
    const format = db.transaction(() => sync.updateInferredFormat(db, note.id));
    expect(format.note_id).toBe(note.id);
    // Ordinary reads still exclude the trashed body.
    expect(host.ctx.notes.repository.getNoteContent(note.id, db)).toBeNull();
    expect(() => sync.updateInferredFormat(db, 'note_missing_sync')).toThrow('Query returned no rows');
  });
});

describe('R4-SYNC-02 notes.sync.prepareRelation negative i64 CAS', () => {
  it('keeps exact bigint outside the two-sided safe range inside the caller transaction', async () => {
    const sync = host.ctx.notes.sync!;
    const db = storage.database('vfs');
    const note = await host.invoke<{ id: string }>('notes_create', { note: { title: 'neg cas', content_md: 'b' } });
    db.run(`INSERT INTO note_learning_relations
      (id,note_id,relation_type,resource_id,locator_json,revision,created_at,updated_at)
      VALUES('neg_cas',?1,'source','target','{"type":"whole"}',0,'now','now')`, [note.id]);
    // Rust: current.unwrap_or(0).checked_add(1), Value::from(i64).
    const prepared = (stored: bigint): unknown => db.transaction(() => {
      db.run("UPDATE note_learning_relations SET revision=?1 WHERE id='neg_cas'", [stored]);
      const payload: Record<string, unknown> = {
        relation_type: 'source', locator_json: '{"type":"whole"}', revision: 1,
      };
      sync.prepareRelation(db, 'neg_cas', payload);
      return payload.revision;
    });
    expect(prepared(-9_007_199_254_740_994n)).toBe(-9_007_199_254_740_993n);
    expect(prepared(-9_007_199_254_740_993n)).toBe(-9_007_199_254_740_992n);
    expect(prepared(-9_007_199_254_740_992n)).toBe(Number.MIN_SAFE_INTEGER);
    expect(prepared(-9_223_372_036_854_775_808n)).toBe(-9_223_372_036_854_775_807n);
    expect(prepared(-2n)).toBe(-1);
    expect(prepared(9_007_199_254_740_990n)).toBe(Number.MAX_SAFE_INTEGER);
    expect(prepared(9_007_199_254_740_991n)).toBe(9_007_199_254_740_992n);
    expect(() => prepared(9_223_372_036_854_775_807n)).toThrow('Relation revision exhausted');
    // The failed call rolled back the caller transaction's UPDATE as well.
    const exact = defineQuery<void, { revision: bigint }>(
      "SELECT revision FROM note_learning_relations WHERE id='neg_cas'", { options: { safeIntegers: true } });
    expect(db.get(exact)!.revision).toBe(9_007_199_254_740_991n);
  });
});

describe('L10-V2-06 stored JSON cells decode like serde', () => {
  it('note tags with a lone surrogate escape fall back to [] through notes_get and notes_list_meta', async () => {
    const note = await host.invoke<{ id: string }>('notes_create', {
      note: { title: 'surrogate tags', content_md: 'body', tags: ['ok'] },
    });
    // serde_json rejects "\ud800" (lone leading surrogate); JSON.parse accepts it.
    storage.database('vfs').run('UPDATE notes SET tags=?2 WHERE id=?1', [note.id, '["ok","\\ud800"]']);
    expect((await host.invoke<{ tags: string[] }>('notes_get', { id: note.id })).tags).toEqual([]);
    const meta = await host.invoke<Array<{ id: string; tags: string[] }>>('notes_list_meta', {});
    expect(meta.find((item) => item.id === note.id)!.tags).toEqual([]);
  });

  it('user_todo_list_items renders repeat_json as serde TodoRepeatRule and tags_json as Vec<Value>', async () => {
    const executor = host.ctx.notes.tools!.userTodo;
    const run = async (name: string, args: Record<string, unknown>) => {
      const call = { id: `todo-json-${name}`, name: `builtin-${name}`, arguments: args };
      const result = await executor.execute(call, context(call));
      expect(result.success, result.error).toBe(true);
      return result.output as Record<string, unknown>;
    };
    const created = await run('user_todo_create_item', { title: 'serde repeat' });
    const id = (created.item as { id: string }).id;
    const db = storage.database('vfs');
    const repeatOf = async (repeatJson: string, tagsJson = '["t"]') => {
      db.run('UPDATE todo_items SET repeat_json=?2, tags_json=?3 WHERE id=?1', [id, repeatJson, tagsJson]);
      const listed = await run('user_todo_list_items', { page_size: 20 });
      const item = (listed.items as Array<Record<string, unknown>>).find((entry) => entry.id === id)!;
      return { repeat: item.repeat, tags: item.tags };
    };
    expect((await repeatOf('{"freq":"weekly","interval":2,"byWeekday":[5,1,1],"extra":true}')).repeat)
      .toEqual({ freq: 'weekly', interval: 2, byWeekday: [1, 5] });
    expect((await repeatOf('["daily"]')).repeat).toEqual({ freq: 'daily', interval: 1, byWeekday: null });
    expect((await repeatOf('["weekly",3,[0]]')).repeat).toEqual({ freq: 'weekly', interval: 3, byWeekday: [0] });
    for (const invalid of [
      '{"freq":"daily","interval":2.0}', '{"freq":"daily","interval":1e0}',
      '{"freq":"daily","freq":"weekly"}', '{"freq":"weekly","byWeekday":[1.0]}',
      '{"freq":"daily","interval":null}', '["daily",1,null,0]', '[]', '{"freq":"daily","interval":-1}',
    ]) {
      expect((await repeatOf(invalid)).repeat, invalid).toBeNull();
    }
    expect((await repeatOf('["daily"]', '["a",1,"b"]')).tags).toEqual(['a', 'b']);
    expect((await repeatOf('["daily"]', '["a","\\udc00"]')).tags).toEqual([]);
  });
});

describe('L10-V2-03 history policy nanoseconds', () => {
  it.each([
    ['2026-11-04T12:00:00.000000001Z', '2026-11-04T12:00:00.000000002Z', true],
    ['2026-11-04T12:00:00.000000002Z', '2026-11-04T12:00:00.000000001Z', false],
    ['2026-11-04T13:00:00.000000002+01:00', '2026-11-04T12:00:00.000000002Z', false],
    ['not-a-timestamp', '2026-11-04T12:00:00Z', true],
  ])('coalescing compares full RFC3339 timestamps: %s / %s', async (previous, policy, retained) => {
    const note = await host.invoke<{ id: string }>('notes_create', {
      note: { title: 'nanosecond policy', content_md: 'first' },
    });
    const db = storage.database('vfs');
    const revisions = host.ctx.notes.revisions;
    await host.invoke('notes_history_set_retention', {
      policy: { edit_bucket_seconds: 86400, max_edit_versions: null },
    });
    await host.invoke('notes_update', { note: { id: note.id, content_md: 'second' } });
    const latest = db.one<{ version_id: string }>(
      'SELECT version_id FROM note_document_revisions WHERE note_id=?1 ORDER BY seq DESC LIMIT 1', [note.id]);
    db.run('UPDATE note_document_revisions SET created_at=?2 WHERE version_id=?1', [latest.version_id, previous]);
    db.run('UPDATE note_history_retention SET updated_at=?1 WHERE id=1', [policy]);
    // Snapshot a changed title through the published production service; no test
    // copy of the coalescing algorithm and no fake time parser.
    db.run('UPDATE notes SET title=?2 WHERE id=?1', [note.id, 'changed']);
    revisions.snapshot(db, note.id, 'edit');
    expect(db.get('SELECT 1 FROM note_document_revisions WHERE version_id=?1', [latest.version_id]) !== undefined)
      .toBe(retained);
  });
});

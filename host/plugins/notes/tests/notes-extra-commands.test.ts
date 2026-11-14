import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { regex as nativeRegex } from '../../../platform/native/regex/index.ts';
import notes from '../index.ts';
import { configureNotesRepository, noteRepository } from '../repository/notes.ts';
import { noteRevisionRepository } from '../repository/revisions.ts';
import {
  clearPending, registerEditAck, registerEditResult,
} from '../repository/canvas-edits.ts';
import type { CanvasAIEditResult } from '../../../../contracts/ipc/generated/L10-notes.ts';
import { OperationGuardError } from '../../backup/api.ts';
import paths from '../../../platform/paths/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
const deletePermits = { acquired: 0, released: 0 };
let permitFailure: OperationGuardError | null = null;

type Host = Awaited<ReturnType<typeof createTestHost>>;
type Storage = ReturnType<typeof createStorageService>;
let host: Host;
let storage: Storage;

beforeAll(async () => {
  host = await createTestHost();
  storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  await storage.migrations.runAll();
  host.ctx.provide('storage', storage);
  host.ctx.provide('nativeRegex', nativeRegex);
  // L21's formal main entry is governance.tryAcquireOperationGuard; keep the
  // real provider shape and structured failure type in tests.
  host.ctx.provide('governance', {
    tryAcquireOperationGuard(kind: string) {
      expect(kind).toBe('delete_propagation');
      if (permitFailure !== null) throw permitFailure;
      deletePermits.acquired += 1;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          deletePermits.released += 1;
        },
      };
    },
  } as never);
  host.ctx.provide('settings', createSettingsStore({
    db: () => storage.database('mistakes'),
    secureStore: () => null,
    isSensitiveKey: () => false,
  }));
  await host.install(paths, vfsRepos, notes);
}, 120000);

afterAll(async () => {
  configureNotesRepository(null);
  await host.dispose();
  storage.dispose();
});

beforeEach(() => {
  storage.database('vfs').exec(`PRAGMA foreign_keys=OFF;
    DELETE FROM note_document_revisions; DELETE FROM note_document_formats;
    DELETE FROM note_learning_relations; DELETE FROM note_transfer_operations;
    DELETE FROM note_review_save_receipts; DELETE FROM note_review_save_operations;
    DELETE FROM note_state; DELETE FROM note_editor_lease_acks;
    DELETE FROM note_editor_write_grants; DELETE FROM note_editor_lease_notes;
    DELETE FROM note_editor_leases; DELETE FROM note_editor_participants;
    DELETE FROM note_links; DELETE FROM note_tags; DELETE FROM folder_items;
    DELETE FROM notes; DELETE FROM __lance_orphan_queue; DELETE FROM __change_log;
    DELETE FROM resources; PRAGMA foreign_keys=ON;`);
  storage.database('mistakes').run("DELETE FROM settings WHERE key LIKE 'notes.%'");
  host.events.length = 0;
  permitFailure = null;
  clearPending();
}, 30000);

interface NoteItem {
  id: string;
  title: string;
  content_md: string;
  tags: string[];
}

async function create(title = '命令测试', content_md = '正文'): Promise<NoteItem> {
  return host.invoke<NoteItem>('notes_create', { note: { title, content_md, tags: [] } });
}

function basePath(): string {
  return storage.locations.activeDir;
}

describe('notes extra commands', () => {
  it('publishes the format/sync/props surfaces through the notes service', () => {
    const notes = host.ctx.notes;
    expect(notes.format.blocks!('<!-- ds:block-id=a -->\n\nParagraph\n'))
      .toEqual([{ id: 'a', body: 'Paragraph' }]);
    for (const method of ['prepareRelation', 'retargetNoteRelations', 'applyRevision', 'updateInferredFormat'] as const) {
      expect(typeof notes.sync?.[method]).toBe('function');
    }
    for (const method of ['purgeNoteWithConn', 'purgeDeletedNotesWithConn'] as const) {
      expect(typeof notes.repository[method]).toBe('function');
    }
  });

  it('notes.sync service keeps i64 revisions and lossless props_json', async () => {
    const sync = host.ctx.notes.sync!;
    const db = storage.database('vfs');
    const note = await create('Sync precision', 'body');

    db.run(`INSERT INTO note_learning_relations
      (id,note_id,relation_type,resource_id,locator_json,revision,created_at,updated_at)
      VALUES('big',?1,'source','target','{"type":"whole"}',?2,'now','now')`,
    [note.id, 9_007_199_254_740_992n]);
    const relation: Record<string, unknown> = {
      relation_type: 'source', locator_json: '{"type":"whole"}',
    };
    sync.prepareRelation(db, 'big', relation);
    expect(relation.revision).toBe(9_007_199_254_740_993n);

    const versionId = noteRevisionRepository.snapshot(db, note.id, 'before_sync');
    const localProps = '{"nested":{"n":9007199254740992},"other":1}';
    db.run('UPDATE note_document_revisions SET props_json=?1 WHERE version_id=?2',
      [localProps, versionId]);
    const row = db.get<Record<string, unknown>>(
      'SELECT * FROM note_document_revisions WHERE version_id=?1', [versionId])!;
    delete row.seq;
    delete row.edit_bucket;
    delete row.pinned;
    expect(() => sync.applyRevision(db, versionId, {
      ...row, props_json: '{"other":1,"nested":{"n":9007199254740992}}',
    })).not.toThrow();
    expect(() => sync.applyRevision(db, versionId, {
      ...row, props_json: '{"nested":{"n":9007199254740993},"other":1}',
    })).toThrow(`Immutable history conflict: ${versionId} (props_json)`);
  });

  it('canvas commands read, append, replace and set content', async () => {
    const note = await create('Canvas', 'Intro');
    expect(await host.invoke('canvas_note_read', { noteId: note.id })).toBe('Intro');

    await host.invoke('canvas_note_append', { noteId: note.id, content: 'Tail' });
    expect(await host.invoke('canvas_note_read', { noteId: note.id })).toBe('Intro\n\nTail');

    await host.invoke('canvas_note_append', {
      noteId: note.id, content: '## Section\n\nBody', section: null,
    });
    expect(await host.invoke('canvas_note_read', { noteId: note.id, section: 'Section' }))
      .toContain('Body');

    expect(await host.invoke('canvas_note_replace', {
      noteId: note.id, search: 'Tail', replace: 'End', isRegex: false,
    })).toBe(1);
    // F7 nativeRegex (regex crate wasm): `E.d` matches the `End` left above.
    expect(await host.invoke('canvas_note_replace', {
      noteId: note.id, search: 'E.d', replace: 'Done', isRegex: true,
    })).toBe(1);
    expect(await host.invoke('canvas_note_replace', {
      noteId: note.id, search: 'End', replace: 'Done', isRegex: false,
    })).toBe(0);
    expect(await host.invoke('canvas_note_read', { noteId: note.id })).toContain('Done');

    await host.invoke('canvas_note_set', { noteId: note.id, content: 'Fresh' });
    expect(await host.invoke('canvas_note_read', { noteId: note.id })).toBe('Fresh');

    await expect(host.invoke('canvas_note_replace', {
      noteId: note.id, search: '', replace: 'x',
    })).rejects.toEqual({
      error_type: 'Validation', message: '搜索内容不能为空', details: null,
    });
    await expect(host.invoke('canvas_note_read', { noteId: note.id, section: 'Missing' }))
      .rejects.toEqual({ error_type: 'NotFound', message: "章节 'Missing' 未找到", details: null });
    await expect(host.invoke('canvas_note_read', { noteId: 'note_missing' }))
      .rejects.toEqual({ error_type: 'NotFound', message: '笔记不存在或已被删除', details: null });
  });

  it('asset commands save, list, resolve, scan orphans and delete', async () => {
    const note = await create('Assets', '');
    const png = Buffer.from('png-bytes').toString('base64');
    const saved = await host.invoke('notes_save_asset', {
      noteId: note.id, base64Data: `data:image/png;base64,${png}`,
    }) as { absolute_path: string; relative_path: string };
    expect(saved.relative_path.startsWith('notes_assets/_global/')).toBe(true);
    expect(saved.relative_path.endsWith('.png')).toBe(true);

    const listed = await host.invoke('notes_list_assets', { noteId: note.id }) as Array<{ relative_path: string }>;
    expect(listed.map((row) => row.relative_path)).toContain(saved.relative_path);
    expect(await host.invoke('notes_assets_index_scan', { noteId: note.id })).toBe(1);
    // Rust canonicalizes when the file exists, so /var resolves to /private/var.
    expect(await host.invoke('notes_resolve_asset_path', {
      relativePath: saved.relative_path,
    })).toBe(realpathSync(saved.absolute_path));

    const orphans = await host.invoke('notes_assets_scan_orphans', {}) as string[];
    expect(orphans).toContain(saved.relative_path);

    expect(await host.invoke('notes_delete_asset', { relativePath: saved.relative_path })).toBe(true);
    expect(await host.invoke('notes_delete_asset', { relativePath: saved.relative_path })).toBe(false);

    const second = await host.invoke('notes_save_asset', {
      noteId: note.id, base64Data: png, defaultExt: 'bin',
    }) as { relative_path: string };
    const third = await host.invoke('notes_save_asset', {
      noteId: note.id, base64Data: png, defaultExt: 'bin',
    }) as { relative_path: string };
    expect(await host.invoke('notes_assets_bulk_delete', {
      paths: [second.relative_path, third.relative_path],
    })).toBe(2);
    await expect(host.invoke('notes_resolve_asset_path', { relativePath: '../escape' }))
      .rejects.toEqual({ error_type: 'Validation', message: '拒绝访问：路径包含上级目录跳转', details: null });
  });

  it('purge WithConn joins the caller transaction and rolls back with it', async () => {
    const note = await create('Tx purge', 'x');
    await host.invoke('notes_delete', { id: note.id });
    const db = storage.database('vfs');
    expect(() => db.transaction((tx) => {
      host.ctx.notes.repository.purgeNoteWithConn!(tx, note.id);
      expect(noteRepository.getNoteIncludingDeleted(note.id, tx)).toBeNull();
      throw new Error('rollback purge');
    })).toThrow('rollback purge');
    expect(noteRepository.getNoteIncludingDeleted(note.id, db)).not.toBeNull();

    const deleted = await create('Tx purge deleted', 'y');
    await host.invoke('notes_delete', { id: deleted.id });
    expect(db.transaction((tx) => host.ctx.notes.repository.purgeDeletedNotesWithConn!(tx))).toBeGreaterThan(0);
    expect(noteRepository.getNoteIncludingDeleted(deleted.id, db)).toBeNull();
  });

  it('delete commands acquire and release the shared DeletePropagation permit', async () => {
    const acquired = deletePermits.acquired;
    const released = deletePermits.released;
    const note = await create('Permit', 'x');
    await host.invoke('notes_hard_delete', { id: note.id });
    expect(deletePermits.acquired).toBe(acquired + 1);
    expect(deletePermits.released).toBe(released + 1);

    // Failure paths release too (try/finally), matching the Rust guard scope.
    await expect(host.invoke('notes_delete_asset', { relativePath: '../escape' }))
      .rejects.toMatchObject({ error_type: 'Validation' });
    expect(deletePermits.acquired).toBe(acquired + 2);
    expect(deletePermits.released).toBe(released + 2);
  });

  it('keeps L21 structured busy/IO failures instead of parsing messages', async () => {
    const acquired = deletePermits.acquired;
    const released = deletePermits.released;

    permitFailure = new OperationGuardError('busy', '已有数据治理操作正在运行（测试）');
    await expect(host.invoke('notes_delete_asset', { relativePath: 'notes_assets/busy.png' }))
      .rejects.toEqual({
        error_type: 'Validation', message: '已有数据治理操作正在运行（测试）', details: null,
      });

    permitFailure = new OperationGuardError('lock_io', '锁目录不可写（测试）');
    await expect(host.invoke('notes_delete_asset', { relativePath: 'notes_assets/io.png' }))
      .rejects.toEqual({
        error_type: 'FileSystem', message: '锁目录不可写（测试）', details: null,
      });

    expect(deletePermits.acquired).toBe(acquired);
    expect(deletePermits.released).toBe(released);
  });

  it.skipIf(process.platform === 'win32')('hard delete rolls back purge when preparing an asset intent fails', async () => {
    const note = await create('Atomic purge', 'x');
    const png = Buffer.from('atomic-bytes').toString('base64');
    const saved = await host.invoke('notes_save_asset', {
      noteId: note.id, base64Data: `data:image/png;base64,${png}`,
    }) as { absolute_path: string; relative_path: string };
    await host.invoke('notes_delete', { id: note.id });

    // Collection succeeds, but reading the file during prepare fails inside the
    // transaction. The purge must roll back with the prepared intent.
    chmodSync(saved.absolute_path, 0o000);
    await expect(host.invoke('notes_hard_delete', { id: note.id }))
      .rejects.toMatchObject({ error_type: 'FileSystem' });
    expect(noteRepository.getNoteIncludingDeleted(note.id, storage.database('vfs'))).not.toBeNull();
    expect(storage.database('vfs').pluck<number>(
      'SELECT COUNT(*) FROM __file_deletion_journal WHERE local_path=?1',
      [saved.relative_path],
    )).toBe(0);

    chmodSync(saved.absolute_path, 0o644);
    expect(await host.invoke('notes_hard_delete', { id: note.id })).toBe(true);
    expect(noteRepository.getNoteIncludingDeleted(note.id, storage.database('vfs'))).toBeNull();
  });

  it('hard delete and empty trash purge notes and their asset directories', async () => {
    const note = await create('Trash', 'x');
    const png = Buffer.from('bytes').toString('base64');
    const saved = await host.invoke('notes_save_asset', {
      noteId: note.id, base64Data: `data:image/png;base64,${png}`,
    }) as { absolute_path: string };
    await host.invoke('notes_delete', { id: note.id });
    expect(await host.invoke('notes_hard_delete', { id: note.id })).toBe(true);
    expect(await host.invoke('notes_hard_delete', { id: note.id })).toBe(false);
    expect(await host.invoke('notes_db_stats', {})).toMatchObject({ total_notes: 0 });
    expect(() => mkdirSync(join(basePath(), 'unused'))).not.toThrow();

    const first = await create('回收一', 'a');
    const second = await create('回收二', 'b');
    await host.invoke('notes_delete', { id: first.id });
    await host.invoke('notes_delete', { id: second.id });
    expect(await host.invoke('notes_empty_trash', {})).toBe(2);
    expect(await host.invoke('notes_db_stats', {})).toMatchObject({ total_notes: 0 });
    expect(saved.absolute_path.length).toBeGreaterThan(0);
  });

  // N3: cmd/notes.rs:1515-1551 SAVEPOINT/RELEASE, error prefixes, finish only after commit.
  it('hard delete maps purge failure and RELEASE failure with Rust prefixes and never finishes uncommitted intents', async () => {
    const vfs = storage.database('vfs');
    const note = await create('Release failure', 'x');
    const png = Buffer.from('release-bytes').toString('base64');
    const saved = await host.invoke('notes_save_asset', {
      noteId: note.id, base64Data: `data:image/png;base64,${png}`,
    }) as { absolute_path: string; relative_path: string };
    await host.invoke('notes_delete', { id: note.id });
    const journal = () => vfs.pluck<number>(
      'SELECT COUNT(*) FROM __file_deletion_journal WHERE local_path=?1', [saved.relative_path]);

    vfs.exec("CREATE TRIGGER n3_block BEFORE DELETE ON notes BEGIN SELECT RAISE(ABORT,'purge blocked'); END");
    try {
      await expect(host.invoke('notes_hard_delete', { id: note.id })).rejects.toMatchObject({
        error_type: 'Database', message: expect.stringMatching(/^硬删除笔记失败: .*purge blocked/),
      });
    } finally {
      vfs.exec('DROP TRIGGER n3_block');
    }
    expect(vfs.inTransaction).toBe(false);
    expect(noteRepository.getNoteIncludingDeleted(note.id, vfs)).not.toBeNull();

    // A deferred FK violation makes the outer RELEASE (= COMMIT) fail after
    // the purge and prepare succeeded inside the savepoint.
    vfs.exec(`CREATE TABLE n3_ref(note_id TEXT REFERENCES notes(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER n3_dangling AFTER DELETE ON notes BEGIN INSERT INTO n3_ref VALUES(OLD.id); END;`);
    try {
      await expect(host.invoke('notes_hard_delete', { id: note.id })).rejects.toMatchObject({
        error_type: 'Database', message: expect.stringMatching(/^提交笔记硬删除事务失败: .*FOREIGN KEY/),
      });
      // Rust returns on RELEASE failure without ROLLBACK TO; the caller's transaction is still open.
      expect(vfs.inTransaction).toBe(true);
      vfs.exec('ROLLBACK');
    } finally {
      vfs.exec('DROP TRIGGER n3_dangling; DROP TABLE n3_ref;');
    }
    expect(existsSync(saved.absolute_path)).toBe(true);
    expect(journal()).toBe(0);
    expect(noteRepository.getNoteIncludingDeleted(note.id, vfs)).not.toBeNull();

    expect(await host.invoke('notes_hard_delete', { id: note.id })).toBe(true);
    expect(existsSync(saved.absolute_path)).toBe(false);
  });

  it('empty trash maps purge failure with the VFS prefix and rolls back the savepoint', async () => {
    const vfs = storage.database('vfs');
    const note = await create('Empty failure', 'x');
    await host.invoke('notes_delete', { id: note.id });
    vfs.exec("CREATE TRIGGER n3_block BEFORE DELETE ON notes BEGIN SELECT RAISE(ABORT,'purge blocked'); END");
    try {
      await expect(host.invoke('notes_empty_trash', {})).rejects.toMatchObject({
        error_type: 'Database', message: expect.stringMatching(/^VFS 清空回收站失败: .*purge blocked/),
      });
    } finally {
      vfs.exec('DROP TRIGGER n3_block');
    }
    expect(vfs.inTransaction).toBe(false);
    expect(await host.invoke('notes_empty_trash', {})).toBe(1);
  });

  it('preferences and subject RAG configuration persist through settings', async () => {
    expect(await host.invoke('notes_set_pref', { key: 'theme', value: 'dark' })).toBe(true);
    expect(await host.invoke('notes_get_pref', { key: 'theme' })).toBe('dark');
    expect(await host.invoke('notes_get_pref', { key: 'missing' })).toBeNull();

    expect(await host.invoke('notes_get_subject_rag_config', { subject: '数学' }))
      .toEqual({ chunk_size: 512, chunk_overlap: 50, min_chunk_size: 20, rerank_enabled: true });
    expect(await host.invoke('notes_update_subject_rag_config', {
      subject: '数学',
      cfg: { chunk_size: 512, chunk_overlap: 32, min_chunk_size: 20, rerank_enabled: false },
    })).toBe(true);
    expect(await host.invoke('notes_get_subject_rag_config', { subject: '数学' }))
      .toEqual({ chunk_size: 512, chunk_overlap: 32, min_chunk_size: 20, rerank_enabled: false });
    await expect(host.invoke('notes_update_subject_rag_config', {
      subject: '数学',
      cfg: { chunk_size: 40, chunk_overlap: 10, min_chunk_size: 10, rerank_enabled: true },
    })).rejects.toEqual({
      error_type: 'Validation', message: '分块大小必须在50-2048之间', details: null,
    });
  });

  it('mentions search returns empty groups for a blank keyword and keeps the Rust mistake query', async () => {
    await create('微积分基础', '导数是瞬时变化率');
    await create('无关', 'nothing');
    // Rust queries `mistakes.subject`, which the shipped mistakes schema does not
    // define (V20260130__init.sql). The command therefore surfaces the database
    // error for every non-empty keyword; the port keeps that behavior verbatim.
    await expect(host.invoke('notes_mentions_search', { keyword: '微积分', limit: 5 }))
      .rejects.toMatchObject({ error_type: 'Database' });
    expect(await host.invoke('notes_mentions_search', { keyword: '   ' }))
      .toEqual({ notes: [], mistakes: [], irec_cards: [] });
  });

  it('canvas edit callbacks validate request ids and deliver pending acks/results', async () => {
    let acked = false;
    registerEditAck('req-1', () => { acked = true; });
    expect(await host.invoke('chat_v2_canvas_edit_ack', { requestId: 'req-1' })).toBeNull();
    expect(acked).toBe(true);

    let received: CanvasAIEditResult | null = null;
    registerEditResult('req-2', (result) => { received = result; });
    await host.invoke('chat_v2_canvas_edit_result', {
      result: { requestId: 'req-2', success: true, affectedCount: 3 },
    });
    expect(received).toMatchObject({ requestId: 'req-2', success: true, affectedCount: 3 });

    const invalid = JSON.stringify({
      code: 'INVALID_INPUT', message: 'Invalid input: request_id must not be empty',
    });
    await expect(host.invoke('chat_v2_canvas_edit_ack', { requestId: '  ' })).rejects.toBe(invalid);
    await expect(host.invoke('chat_v2_canvas_edit_result', {
      result: { requestId: '', success: false },
    })).rejects.toBe(invalid);
  });

  it('markdown import creates notes from files in single and batch modes', async () => {
    const dir = join(host.app.dataDir, 'imports');
    mkdirSync(dir, { recursive: true });
    const first = join(dir, 'first.md');
    const second = join(dir, 'second.md');
    writeFileSync(first, '# 导入标题\n\n正文内容\n');
    writeFileSync(second, 'no heading\n');

    const node = await host.invoke('notes_import_markdown', {
      request: { filePath: first },
    }) as { id: string; name: string };
    expect(node.name).toBe('导入标题');
    const stored = await host.invoke<NoteItem>('notes_get', { id: node.id });
    expect(stored.content_md).toBe('正文内容\n');

    const missing = join(dir, 'missing.md');
    await expect(host.invoke('notes_import_markdown_batch', {
      request: { items: [{ filePath: second }, { filePath: missing }] },
    })).rejects.toEqual({
      error_type: 'FileSystem', message: `文件不存在: ${missing}`, details: null,
    });
    const invalidTitle = join(dir, 'invalid-title.md');
    writeFileSync(invalidTitle, `# ${'x'.repeat(501)}\n`);
    const batch = await host.invoke('notes_import_markdown_batch', {
      request: { items: [{ filePath: second, titleHint: '自定义标题' }, { filePath: invalidTitle }] },
    }) as { imported: Array<{ id: string; name: string }>; failed: Array<{ file_path: string; message: string }> };
    expect(batch.imported.map((item) => item.name)).toEqual(['自定义标题']);
    expect(batch.failed).toHaveLength(1);
    expect(batch.failed[0]!.file_path).toContain('invalid-title.md');
    expect(batch.failed[0]!.message).toContain('导入 Markdown 笔记失败');
    expect(await host.invoke('rag_rebuild_fts_index', {})).toBe(0);
    expect(await host.invoke('notes_rag_rebuild_fts_index', {})).toBe(0);
  });
});

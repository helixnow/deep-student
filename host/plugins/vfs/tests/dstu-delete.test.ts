import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { DstuNode, VfsFolder } from '../api.ts';
import plugin from '../index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
// boundary-allow cross-plugin-impl: 安装真实 L10 notes 插件，验证 notes 表只经其写入
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: 安装真实 L11 vfs-repos 插件，验证 resources 只经其写入
import reposPlugin from '../../vfs-repos/index.ts';
// boundary-allow cross-plugin-impl: 安装真实 L14 qbank 插件，exam_sheets 级联经其正式 examCascade 服务
import qbankPlugin from '../../qbank/index.ts';

describe('dstu_delete', { timeout: 30_000 }, () => {
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let host: TestHost;
  let conn: DatabaseHandle;
  let template: string;

  beforeAll(async () => {
    template = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-delete-schema-'));
    const source = createStorageService({ baseDir: template, dataLocalDir: template });
    try {
      const report = await source.migrations.runAll();
      expect(report.success, report.error ?? '').toBe(true);
    } finally { source.dispose(); }
  }, 120_000);
  afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-delete-'));
    fs.cpSync(template, root, { recursive: true });
    storage = createStorageService({ baseDir: root, dataLocalDir: root });
    host = await createTestHost({
      plugins: [pathsPlugin, notesPlugin, reposPlugin, indexPlugin, qbankPlugin, plugin],
      provide: { storage },
      app: { dataDir: root },
    });
    conn = host.ctx.vfsDatabase.getConn();
  }, 60_000);
  afterEach(async () => {
    await host?.dispose();
    storage?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }, 60_000);

  const invoke = <T>(cmd: string, args: Record<string, unknown> = {}) => host.invoke<T>(cmd, args);
  const create = (options: Record<string, unknown>, target = '/') => invoke<DstuNode>('dstu_create', {
    path: target,
    options,
  });
  const createFolder = (title: string) => invoke<VfsFolder>('dstu_folder_create', { title });
  const remove = (target: string) => invoke<null>('dstu_delete', { path: target });

  function folderItemDeleted(itemId: string, itemType: string): number {
    return conn.get<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM folder_items WHERE item_id = ?1 AND item_type = ?2',
      [itemId, itemType],
    )!.deleted_at === null ? 0 : 1;
  }

  it('soft deletes notes, their memberships and index units and emits a deleted event', async () => {
    const folder = await createFolder('数学');
    const note = await create({
      type: 'note', name: '待删', content: '正文', metadata: { folderId: folder.id },
    });
    conn.run(
      "INSERT INTO vfs_index_units (id, resource_id, unit_index, text_state, mm_state, created_at, updated_at) VALUES ('u1', ?1, 0, 'pending', 'pending', 1, 1)",
      [note.resourceId!],
    );

    await expect(remove(`/fld_x/notes/${note.id}`)).resolves.toBeNull();
    const row = conn.get<{ deleted_at: string | null; updated_at: string }>(
      'SELECT deleted_at, updated_at FROM notes WHERE id = ?1', [note.id]);
    expect(row!.deleted_at).not.toBeNull();
    expect(row!.updated_at).toBe(row!.deleted_at);
    expect(folderItemDeleted(note.id, 'note')).toBe(1);
    expect(conn.get<{ text_state: string; mm_state: string }>(
      "SELECT text_state, mm_state FROM vfs_index_units WHERE id = 'u1'"))
      .toEqual({ text_state: 'disabled', mm_state: 'disabled' });

    const events = host.eventsNamed('dstu:change') as Array<{ type: string; path: string }>;
    expect(events.at(-1)).toMatchObject({ type: 'deleted', path: `/fld_x/notes/${note.id}` });
    expect(host.eventsNamed(`dstu:change:/fld_x/notes/${note.id}`)).toHaveLength(1);

    // Already soft-deleted rows are idempotent and still emit the event.
    await expect(remove(note.id)).resolves.toBeNull();
    expect((host.eventsNamed('dstu:change') as Array<{ type: string }>)
      .filter(event => event.type === 'deleted')).toHaveLength(2);
  });

  it('soft deletes translations, exams, essays, mindmaps and files with folder memberships', async () => {
    const folder = await createFolder('回收站');
    const translation = await create({
      type: 'translation', name: '译', metadata: { folderId: folder.id },
    });
    const exam = await create({ type: 'exam', name: '卷', metadata: { folderId: folder.id } });
    const session = await create({ type: 'essay', name: '作文', metadata: { folderId: folder.id } });
    const mindmap = await create({
      type: 'mindmap', name: '图',
      content: '{"root":{"id":"root","text":"根"}}',
      metadata: { folderId: folder.id },
    });
    const file = await create({
      type: 'file', name: 'a.txt',
      fileBase64: Buffer.from('abc').toString('base64'),
      metadata: { folderId: folder.id },
    });

    await remove(`/${translation.id}`);
    expect(conn.get<{ deleted_at: string | null; local_version: number }>(
      'SELECT deleted_at, local_version FROM translations WHERE id = ?1', [translation.id])!.deleted_at)
      .not.toBeNull();
    expect(folderItemDeleted(translation.id, 'translation')).toBe(1);

    await remove(exam.id);
    const examRow = conn.get<{ deleted_at: string | null; deletion_batch: string | null }>(
      'SELECT deleted_at, deletion_batch FROM exam_sheets WHERE id = ?1', [exam.id]);
    expect(examRow!.deleted_at).not.toBeNull();
    expect(examRow!.deletion_batch).toMatch(/^exam_delete_[A-Za-z0-9_-]{16}$/);

    await remove(session.id);
    expect(conn.pluck<string>('SELECT deleted_at FROM essay_sessions WHERE id = ?1', [session.id]))
      .not.toBeNull();
    expect(folderItemDeleted(session.id, 'essay')).toBe(1);

    await remove(mindmap.id);
    expect(conn.pluck<string>('SELECT deleted_at FROM mindmaps WHERE id = ?1', [mindmap.id]))
      .not.toBeNull();
    expect(folderItemDeleted(mindmap.id, 'mindmap')).toBe(1);

    await remove(file.id);
    expect(conn.get<{ status: string; deleted_at: string | null }>(
      'SELECT status, deleted_at FROM files WHERE id = ?1', [file.id]))
      .toMatchObject({ status: 'deleted' });
    expect(folderItemDeleted(file.id, 'file')).toBe(1);
  });

  it('soft deletes an essay round, a textbook row and a folder tree through the same command', async () => {
    const updatedAt = new Date(Date.now() - 1000).toISOString();
    conn.run(
      `INSERT INTO resources (id, hash, type, source_id, source_table, storage_mode, data,
                              metadata_json, ref_count, created_at, updated_at)
       VALUES ('res_essay_x', ?1, 'essay', 'essay_x', 'essays', 'inline', 'body', NULL, 0, 1, 1)`,
      [createHash('sha256').update('body').digest('hex')],
    );
    conn.run(
      `INSERT INTO essays (id, resource_id, title, round_number, is_favorite, created_at, updated_at)
       VALUES ('essay_x', 'res_essay_x', '轮次', 1, 0, ?1, ?1)`,
      [updatedAt],
    );
    await remove('essay_x');
    expect(conn.pluck<string>('SELECT deleted_at FROM essays WHERE id = ?1', ['essay_x']))
      .not.toBeNull();

    conn.run(
      `INSERT INTO resources (id, hash, type, source_id, source_table, storage_mode, data,
                              metadata_json, ref_count, created_at, updated_at)
       VALUES ('res_tb_x', ?1, 'file', 'tb_x', 'files', 'inline', '', NULL, 0, 1, 1)`,
      [createHash('sha256').update('tb').digest('hex')],
    );
    conn.run(
      `INSERT INTO files (id, resource_id, sha256, file_name, size, "type", status, created_at, updated_at)
       VALUES ('tb_x', 'res_tb_x', 'aaa', 'book.pdf', 10, 'textbook', 'active', ?1, ?1)`,
      [updatedAt],
    );
    await remove('tb_x');
    expect(conn.get<{ status: string; deleted_at: string | null }>(
      "SELECT status, deleted_at FROM files WHERE id = 'tb_x'"))
      .toMatchObject({ status: 'deleted' });

    const folder = await createFolder('父');
    const child = await invoke<VfsFolder>('dstu_folder_create', { title: '子', parentId: folder.id });
    const note = await create({
      type: 'note', name: '树内笔记', metadata: { folderId: child.id },
    });
    await remove(`/${folder.id}`);
    expect(conn.pluck<string>('SELECT deleted_at FROM folders WHERE id = ?1', [folder.id]))
      .not.toBeNull();
    expect(conn.pluck<string>('SELECT deleted_at FROM folders WHERE id = ?1', [child.id]))
      .not.toBeNull();
    expect(conn.pluck<string>('SELECT deleted_at FROM notes WHERE id = ?1', [note.id]))
      .not.toBeNull();
  });

  it('resolves UUID-style ids through the fallback lookup', async () => {
    const uuid = '00000000-0000-4000-8000-000000000001';
    const updatedAt = new Date().toISOString();
    conn.run(
      `INSERT INTO resources (id, hash, type, source_id, source_table, storage_mode, data,
                              metadata_json, ref_count, created_at, updated_at)
       VALUES ('res_uuid_note', ?1, 'note', ?2, 'notes', 'inline', 'uuid body', NULL, 0, 1, 1)`,
      [createHash('sha256').update('uuid body').digest('hex'), uuid],
    );
    conn.run(
      `INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at)
       VALUES (?1, 'res_uuid_note', 'UUID 笔记', '[]', 0, ?2, ?2)`,
      [uuid, updatedAt],
    );

    await remove(uuid);
    expect(conn.pluck<string>('SELECT deleted_at FROM notes WHERE id = ?1', [uuid]))
      .not.toBeNull();
  });

  it('keeps owner savepoints inside the mixed-resource delete transaction', async () => {
    const folder = await createFolder('混合回滚');
    const translation = await create({ type: 'translation', name: '译', metadata: { folderId: folder.id } });
    const mindmap = await create({ type: 'mindmap', name: '图', content: '{"root":{"id":"root","text":"根"}}',
      metadata: { folderId: folder.id } });
    const eventCount = host.eventsNamed('dstu:change').length;
    conn.exec(`CREATE TRIGGER reject_mindmap_delete BEFORE UPDATE OF deleted_at ON folder_items
      WHEN NEW.item_id = '${mindmap.id}' BEGIN SELECT RAISE(ABORT, 'deletion rejected'); END;`);
    await expect(invoke('dstu_delete_many', { paths: [translation.id, mindmap.id] }))
      .rejects.toBe('Database error: deletion rejected');
    expect(conn.pluck('SELECT deleted_at FROM translations WHERE id = ?1', [translation.id])).toBeNull();
    expect(conn.pluck('SELECT deleted_at FROM mindmaps WHERE id = ?1', [mindmap.id])).toBeNull();
    expect(folderItemDeleted(translation.id, 'translation')).toBe(0);
    expect(folderItemDeleted(mindmap.id, 'mindmap')).toBe(0);
    expect(host.eventsNamed('dstu:change')).toHaveLength(eventCount);
    conn.exec('DROP TRIGGER reject_mindmap_delete');
    await expect(remove(mindmap.id)).resolves.toBeNull();
    expect(folderItemDeleted(mindmap.id, 'mindmap')).toBe(1);
  });

  it('reports invalid paths, unknown ids and missing rows with Rust messages', async () => {
    await expect(remove('zzz_1')).rejects.toBe(
      'Invalid DSTU path: Path must contain a resource ID: zzz_1',
    );
    await expect(remove('res_1')).rejects.toBe(
      'Invalid node type: resources (id=res_1)',
    );
    await expect(remove('/no-id-here')).rejects.toBe(
      'Invalid DSTU path: Path must contain a resource ID: /no-id-here',
    );
    await expect(remove('note_missing')).rejects.toBe(
      'VFS error: delete failed (type=notes, id=note_missing): Note not found: note_missing',
    );
    await expect(remove('tr_missing')).rejects.toBe(
      'VFS error: delete failed (type=translations, id=tr_missing): Translation not found: tr_missing',
    );
    await expect(remove('exam_missing')).rejects.toBe(
      'VFS error: delete failed (type=exams, id=exam_missing): ExamSheet not found: exam_missing',
    );
    await expect(remove('mm_missing')).rejects.toBe(
      'VFS error: delete failed (type=mindmaps, id=mm_missing): MindMap not found: mm_missing',
    );
    await expect(remove('fld_missing')).rejects.toBe(
      'VFS error: delete failed (type=folders, id=fld_missing): FOLDER_NOT_FOUND: fld_missing',
    );
    expect((host.eventsNamed('dstu:change') as Array<{ type: string }>)
      .filter(event => event.type === 'deleted')).toHaveLength(0);
  });
});

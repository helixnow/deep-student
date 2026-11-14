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

describe('dstu_set_favorite', { timeout: 30_000 }, () => {
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let host: TestHost;
  let conn: DatabaseHandle;
  let template: string;

  beforeAll(async () => {
    template = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-favorite-schema-'));
    const source = createStorageService({ baseDir: template, dataLocalDir: template });
    try {
      const report = await source.migrations.runAll();
      expect(report.success, report.error ?? '').toBe(true);
    } finally { source.dispose(); }
  }, 120_000);
  afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-favorite-'));
    fs.cpSync(template, root, { recursive: true });
    storage = createStorageService({ baseDir: root, dataLocalDir: root });
    host = await createTestHost({ plugins: [pathsPlugin, notesPlugin, reposPlugin, indexPlugin, plugin], provide: { storage }, app: { dataDir: root } });
    conn = host.ctx.vfsDatabase.getConn();
  }, 60_000);
  afterEach(async () => {
    await host?.dispose();
    storage?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }, 60_000);

  const invoke = <T>(cmd: string, args: Record<string, unknown> = {}) => host.invoke<T>(cmd, args);
  const create = (options: Record<string, unknown>) => invoke<DstuNode>('dstu_create', {
    path: '/',
    options,
  });
  const setFavorite = (target: string, favorite = true) => invoke<null>('dstu_set_favorite', {
    path: target,
    favorite,
  });

  function insertFile(id: string, fileName: string): void {
    const now = new Date().toISOString();
    conn.run(
      `INSERT INTO resources (id, hash, type, source_id, source_table, storage_mode, data,
                              metadata_json, ref_count, created_at, updated_at)
       VALUES (?1, ?2, 'file', ?3, 'files', 'inline', '', NULL, 0, 1, 1)`,
      [`res_${id}`, createHash('sha256').update(id).digest('hex'), id],
    );
    conn.run(
      `INSERT INTO files (id, resource_id, sha256, file_name, size, "type", tags_json,
                          is_favorite, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 10, 'textbook', '[]', 0, 'active', ?5, ?5)`,
      [id, `res_${id}`, createHash('sha256').update(id).digest('hex'), fileName, now],
    );
  }

  it('marks a note favorite, bumps its timestamp and emits an updated event', async () => {
    const note = await create({ type: 'note', name: '收藏', content: 'x' });
    await expect(setFavorite(note.id)).resolves.toBeNull();

    const row = conn.get<{ is_favorite: number; updated_at: string }>(
      'SELECT is_favorite, updated_at FROM notes WHERE id = ?1', [note.id]);
    expect(row!.is_favorite).toBe(1);
    expect(Date.parse(row!.updated_at)).toBeGreaterThanOrEqual(note.updatedAt);
    const fetched = await invoke<DstuNode>('dstu_get', { path: note.id });
    expect(fetched.metadata).toMatchObject({ isFavorite: true });

    const events = host.eventsNamed('dstu:change') as Array<{ type: string; path: string; node: DstuNode }>;
    expect(events.at(-1)).toMatchObject({ type: 'updated', path: note.id });
    expect(events.at(-1)!.node.metadata).toMatchObject({ isFavorite: true });
    expect(host.eventsNamed(`dstu:change:${note.id}`)).toHaveLength(1);

    await setFavorite(note.id, false);
    expect(conn.pluck<number>('SELECT is_favorite FROM notes WHERE id = ?1', [note.id])).toBe(0);
  });

  it('handles translations, exams, folders and mindmaps with per-repository semantics', async () => {
    const translation = await create({
      type: 'translation', name: '译', metadata: { sourceText: 'a', translatedText: 'b' },
    });
    const version = conn.pluck<number>(
      'SELECT local_version FROM translations WHERE id = ?1', [translation.id])!;
    await setFavorite(translation.id);
    expect(conn.get<{ is_favorite: number; local_version: number }>(
      'SELECT is_favorite, local_version FROM translations WHERE id = ?1', [translation.id]))
      .toEqual({ is_favorite: 1, local_version: version + 1 });

    const exam = await create({ type: 'exam', name: '卷' });
    await setFavorite(exam.id);
    expect(conn.pluck<number>('SELECT is_favorite FROM exam_sheets WHERE id = ?1', [exam.id]))
      .toBe(1);

    const folder = await invoke<VfsFolder>('dstu_folder_create', { title: '夹' });
    await setFavorite(folder.id);
    expect(conn.pluck<number>('SELECT is_favorite FROM folders WHERE id = ?1', [folder.id])).toBe(1);
    // Folder nodes deliberately omit isFavorite from their metadata payload.
    const folderEvent = (host.eventsNamed('dstu:change') as Array<{ node: DstuNode }>).at(-1)!;
    expect(folderEvent.node).toMatchObject({ id: folder.id, type: 'folder' });
    expect(folderEvent.node.metadata).not.toHaveProperty('isFavorite');

    const mindmap = await create({
      type: 'mindmap', name: '图', content: '{"root":{"id":"root","text":"根"}}',
    });
    const before = conn.pluck<string>('SELECT updated_at FROM mindmaps WHERE id = ?1', [mindmap.id]);
    await setFavorite(mindmap.id);
    expect(conn.pluck<number>('SELECT is_favorite FROM mindmaps WHERE id = ?1', [mindmap.id]))
      .toBe(1);
    // Mindmap favorites intentionally do not bump updated_at.
    expect(conn.pluck<string>('SELECT updated_at FROM mindmaps WHERE id = ?1', [mindmap.id]))
      .toBe(before);
  });

  it('routes tb_ ids through the file repository', async () => {
    insertFile('tb_fav', 'book.pdf');
    await setFavorite('tb_fav');
    expect(conn.pluck<number>('SELECT is_favorite FROM files WHERE id = ?1', ['tb_fav'])).toBe(1);
    const event = (host.eventsNamed('dstu:change') as Array<{ node: DstuNode }>).at(-1)!;
    expect(event.node).toMatchObject({ id: 'tb_fav', type: 'textbook', previewType: 'pdf' });

    const file = await create({
      type: 'file', name: 'a.txt', fileBase64: Buffer.from('a').toString('base64'),
    });
    await setFavorite(file.id);
    expect(conn.pluck<number>('SELECT is_favorite FROM files WHERE id = ?1', [file.id])).toBe(1);
  });

  it('updates essay sessions but rejects single essay rounds like Rust', async () => {
    const session = await create({ type: 'essay', name: '会话' });
    await setFavorite(session.id);
    expect(conn.pluck<number>('SELECT is_favorite FROM essay_sessions WHERE id = ?1', [session.id]))
      .toBe(1);
    const sessionEvent = (host.eventsNamed('dstu:change') as Array<{ node: DstuNode }>).at(-1)!;
    expect(sessionEvent.node.metadata).toMatchObject({ isFavorite: true });

    const now = new Date().toISOString();
    conn.run(
      `INSERT INTO resources (id, hash, type, source_id, source_table, storage_mode, data,
                              metadata_json, ref_count, created_at, updated_at)
       VALUES ('res_essay_fav', ?1, 'essay', 'essay_fav', 'essays', 'inline', 'x', NULL, 0, 1, 1)`,
      [createHash('sha256').update('x').digest('hex')],
    );
    conn.run(
      `INSERT INTO essays (id, resource_id, title, round_number, is_favorite, created_at, updated_at)
       VALUES ('essay_fav', 'res_essay_fav', '轮次', 1, 0, ?1, ?1)`,
      [now],
    );
    await expect(setFavorite('essay_fav')).rejects.toBe('EssaySession not found: essay_fav');
    expect(conn.pluck<number>("SELECT is_favorite FROM essays WHERE id = 'essay_fav'")).toBe(0);
  });

  it('reports repository and unsupported-type errors', async () => {
    await expect(setFavorite('note_missing')).rejects.toBe('操作失败');
    await expect(setFavorite('fld_missing')).rejects.toBe('FOLDER_NOT_FOUND: fld_missing');
    await expect(setFavorite('tr_missing')).rejects.toBe('Translation not found: tr_missing');
    await expect(setFavorite('exam_missing')).rejects.toBe('ExamSheet not found: exam_missing');
    await expect(setFavorite('mm_missing')).rejects.toBe('MindMap not found: mm_missing');
    await expect(setFavorite('res_1'))
      .rejects.toBe("Resource type 'resources' does not support favorite operation");
    await expect(setFavorite('zzz_1')).rejects.toBe(
      'Invalid DSTU path: Path must contain a resource ID: zzz_1',
    );
    expect((host.eventsNamed('dstu:change') as Array<{ type: string }>)
      .filter(event => event.type === 'updated')).toHaveLength(0);
  });
});

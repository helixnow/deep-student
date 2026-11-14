import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createSettingsService } from '../../../platform/settings/index.ts';
import { createNodeFiles } from '../../../platform/files/index.ts';
import plugin from '../index.ts';
// boundary-allow cross-plugin-impl: exercise loader dependencies with real owner plugins
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: exercise loader dependencies with real owner plugins
import reposPlugin from '../../vfs-repos/index.ts';
// boundary-allow cross-plugin-impl: verify command ownership when both production VFS plugins are installed
import handlersPlugin from '../../vfs-handlers/index.ts';
// boundary-allow cross-plugin-impl: install the actual document provider required by the handlers
import mediaPlugin from '../../media/index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-wiring-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const result = await storage.migrations.runAll();
  expect(result.success, result.error ?? '').toBe(true);
}, 120_000);
afterAll(() => { storage?.dispose(); fs.rmSync(root, { recursive: true, force: true }); });

it('requires the real vfsIndex service instead of silently skipping deletion cleanup', async () => {
  await expect(createTestHost({ plugins: [pathsPlugin, notesPlugin, reposPlugin, plugin],
    provide: { storage } })).rejects.toThrow('vfsIndex');
});

async function createCombinedHost() {
  const settings = createSettingsService({ db: () => storage.database('mistakes'),
    secureStore: () => null, secrets: { isSensitiveKey: () => false } });
  return createTestHost({
    plugins: [pathsPlugin, notesPlugin, reposPlugin, indexPlugin, plugin, mediaPlugin, handlersPlugin],
    provide: { storage, settings, files: createNodeFiles({ roots: [{ name: 'appData', path: root }] }) },
    app: { dataDir: root },
    shell: op => {
      if (op === 'app.pdfStreamAllowedDirs') return [root];
      throw new Error(`Unexpected shell operation: ${op}`);
    },
  });
}

it('registers filestream_check_access once alongside DSTU and serves the same allowed media', async () => {
  const host = await createCombinedHost();
  try {
    const file = path.join(root, 'clip.mp4');
    fs.writeFileSync(file, 'media');
    expect(host.coverage().duplicates).toEqual([]);
    expect(await host.invoke('filestream_check_access', { path: file })).toBe(true);
    expect(await host.invoke('filestream_check_access', { path: path.join(root, 'missing.mp4') })).toBe(false);
    const response = await host.protocol('filestream', `filestream://localhost/${encodeURIComponent(file)}`);
    expect(response.status).toBe(200);
    expect(response.text()).toBe('media');
    expect(await host.invoke('dstu_folder_list')).toEqual([]);
  } finally { await host.dispose(); }
});

it('filestream_check_access returns false for an unresolvable path before requesting Shell allowed dirs', async () => {
  const host = await createCombinedHost();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-wiring-outside-'));
  try {
    // file_stream_protocol.rs:720-724: canonicalize failure returns Ok(false) before resolve_allowed_dirs.
    const before = host.shellRequests.length;
    expect(await host.invoke('filestream_check_access', { path: '' })).toBe(false);
    expect(await host.invoke('filestream_check_access', { path: path.join(root, 'absent', 'missing.mp4') })).toBe(false);
    expect(host.shellRequests.slice(before)).toEqual([]);

    const blobs = host.ctx.vfsDatabase.blobsDir();
    fs.mkdirSync(blobs, { recursive: true });
    fs.mkdirSync(path.join(root, '.hidden'), { recursive: true });
    const cases: [string, boolean][] = [
      [path.join(root, 'chain.mp4'), true],
      [path.join(blobs, 'chainhash'), true],
      [path.join(root, 'chain.exe'), false],
      [path.join(root, '.hidden', 'chain.mp4'), false],
      [path.join(outside, 'chain.mp4'), false],
    ];
    for (const [file] of cases) fs.writeFileSync(file, 'data');
    for (const [file, expected] of [...cases, [root, false] as [string, boolean]]) {
      const start = host.shellRequests.length;
      expect(await host.invoke('filestream_check_access', { path: file }), file).toBe(expected);
      expect(host.shellRequests.slice(start).map(request => request.op)).toEqual(['app.pdfStreamAllowedDirs']);
    }
  } finally {
    await host.dispose();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

it('test_vfs_resource_type_from_str', async () => {
  const host = await createCombinedHost();
  try {
    for (const [input, expected] of [['note', 'note'], ['TEXTBOOK', 'textbook']]) {
      const created = await host.invoke('vfs_create_or_reuse', {
        params: { type: input, data: `resource-type-${input}` },
      }) as { resourceId: string };
      expect(await host.invoke('vfs_get_resource', { resourceId: created.resourceId }))
        .toMatchObject({ type: expected });
    }
    await expect(host.invoke('vfs_create_or_reuse', { params: { type: 'invalid', data: '' } }))
      .rejects.toBe("Invalid argument 'type': Invalid resource type: invalid");
  } finally { await host.dispose(); }
});

it('test_vfs_list_item_serialization', async () => {
  const host = await createCombinedHost();
  try {
    const note = await host.invoke('dstu_create', { path: '/', options: {
      type: 'note', name: 'Test Note', content: 'list-item-wire',
    } }) as { id: string };
    const items = await host.invoke('vfs_search_all', { params: { query: 'Test Note' } }) as { id: string }[];
    const item = items.find(item => item.id === note.id);
    expect(item).toBeDefined();
    expect(JSON.stringify(item)).toContain('"resourceId"');
    expect(JSON.stringify(item)).toContain('"previewType":"markdown"');
    expect(JSON.stringify(item)).toContain('"type":"note"');
  } finally { await host.dispose(); }
});

it('test_source_id_prefix_parsing', async () => {
  const host = await createCombinedHost();
  try {
    const conn = host.ctx.vfsDatabase.getConnSafe(), repos = host.ctx.vfsRepo;
    const note = host.ctx.notes.repository.createNote({ title: '笔记标题', content: '', tags: [] }, conn);
    // handlers.rs:8181 pins the legacy tb_ branch; textbook_repo.rs:136-137
    // now creates file_ ids, which handlers.rs:1300 intentionally leaves as ids.
    const book = { id: 'tb_def456' };
    conn.run(`INSERT INTO files (id, sha256, file_name, size, type, status, created_at, updated_at)
      VALUES (?1, 'legacy-prefix-book', '教材.pdf', 10, 'document', 'active', '0', '0')`, [book.id]);
    const modernBook = repos.textbooks.createTextbook(conn, 'prefix-book', '教材.pdf', 10, null, null);
    expect(modernBook.id).toMatch(/^file_/);
    expect(await host.invoke('vfs_get_resource_path', { sourceId: modernBook.id })).toBe(`/${modernBook.id}`);
    const exam = repos.exams.createExamSheet(conn, { examName: '题目标题', tempId: 'prefix-temp', metadataJson: {}, previewJson: {}, status: 'completed', folderId: null });
    const translation = repos.translations.createTranslation(conn, { title: '翻译标题', source: 's', translated: 't', srcLang: 'zh', tgtLang: 'en' });
    const essay = repos.essays.createEssay(conn, { title: '作文标题', content: '正文' });
    // handlers.rs:1284-1291 deliberately selects translations.id, not title.
    for (const [id, title] of [[note.id, '笔记标题'], [book.id, '教材.pdf'], [exam.id, '题目标题'], [translation.id, translation.id], [essay.id, '作文标题']]) {
      expect(await host.invoke('vfs_get_resource_path', { sourceId: id })).toBe(`/${title}`);
    }
  } finally { await host.dispose(); }
});

it('test_path_format', async () => {
  const host = await createCombinedHost();
  try {
    const parent = await host.invoke('dstu_folder_create', { title: '高考复习' }) as { id: string };
    const child = await host.invoke('dstu_folder_create', { title: '函数', parentId: parent.id }) as { id: string };
    const conn = host.ctx.vfsDatabase.getConnSafe();
    const note = host.ctx.notes.repository.createNote({ title: '笔记标题', content: '', tags: [] }, conn);
    expect(await host.invoke('vfs_get_resource_path', { sourceId: note.id })).toBe('/笔记标题');
    await host.invoke('dstu_folder_add_item', { folderId: child.id, itemType: 'note', itemId: note.id });
    expect(await host.invoke('vfs_get_resource_path', { sourceId: note.id })).toBe('/高考复习/函数/笔记标题');
  } finally { await host.dispose(); }
});

it('test_path_length_constraint', async () => {
  const host = await createCombinedHost();
  try {
    const folder = await host.invoke('dstu_folder_create', { title: '文件夹' }) as { id: string };
    const conn = host.ctx.vfsDatabase.getConnSafe();
    const short = host.ctx.notes.repository.createNote({ title: '笔记', content: '', tags: [] }, conn);
    const long = host.ctx.notes.repository.createNote({ title: '笔'.repeat(400), content: '', tags: [] }, conn);
    for (const note of [short, long]) await host.invoke('dstu_folder_add_item', { folderId: folder.id, itemType: 'note', itemId: note.id });
    const shortPath = await host.invoke('vfs_get_resource_path', { sourceId: short.id }) as string;
    const longPath = await host.invoke('vfs_get_resource_path', { sourceId: long.id }) as string;
    expect(Buffer.byteLength(shortPath)).toBeLessThanOrEqual(1000); expect(Buffer.byteLength(longPath)).toBeGreaterThan(1000);
    expect(conn.pluck('SELECT cached_path FROM folder_items WHERE item_id=?1', [short.id])).toBe(shortPath);
    expect(conn.pluck('SELECT cached_path FROM folder_items WHERE item_id=?1', [long.id])).toBeNull();
    expect(await host.invoke('vfs_update_path_cache', { folderId: folder.id })).toBe(1);
  } finally { await host.dispose(); }
});

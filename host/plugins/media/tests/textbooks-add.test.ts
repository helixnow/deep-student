/**
 * `src/cmd/textbooks.rs::textbooks_add` 生产入口契约测试（`host.invoke('textbooks_add', …)`）。
 * Rust 侧没有 textbooks_add 的单元测试；以下断言逐分支对照 textbooks.rs:114-700。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import type { VfsIndexService } from '../../vfs-index/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
// boundary-allow cross-plugin-impl: 测试用 L11 真实仓储构造依赖；被测对象是本 lane 的命令
import { TextbookRepo } from '../../vfs-repos/repository/textbooks.ts';
// boundary-allow cross-plugin-impl: 同上；blob 内容寻址存储的真实行为
import { BlobRepo } from '../../vfs-repos/repository/blobs.ts';
// boundary-allow cross-plugin-impl: 同上；folder_items 挂载的真实行为
import { FolderRepo } from '../../vfs-repos/repository/folders.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';
import { renderProgressPercent } from '../src/textbooks-add.ts';

type RenderImpl = (conn: SqlExecutor, blobsDir: string, bytes: Uint8Array, config: unknown,
  progress?: (current: number, total: number) => void) => Promise<unknown>;

let template: string;
let root: string;
let storage: ReturnType<typeof createStorageService>;
let conn: DatabaseHandle;
let database: VfsDatabase;
let host: TestHost;
let textbooks: TextbookRepo;
let folders: FolderRepo;
let pipelineStarts: Array<[string, unknown]>;
let eventsAtPipelineStart: string[][];
let renderImpl: RenderImpl;

function settings() {
  const values = new Map<string, string>();
  return {
    get: (key: string) => values.get(key) ?? null,
    save: (key: string, value: string) => { values.set(key, value); },
  };
}

async function startHost(withDatabase: boolean): Promise<TestHost> {
  return createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(),
      settings: settings(),
      paths: { appDataDir: root },
      ...(withDatabase ? { vfsDatabase: database } : {}),
      vfsRepo: {
        textbooks,
        blobs: new BlobRepo(),
        folders,
        // L11 `attachmentProcessing.renderPdf`（render_pdf_preview_with_progress）的可控替身：
        // pdfium 渲染不是本命令的被测对象，这里只驱动其返回/失败/进度回调三种形状。
        attachmentProcessing: {
          renderPdf: (c: SqlExecutor, dir: string, bytes: Uint8Array, config: unknown,
            progress?: (current: number, total: number) => void) => renderImpl(c, dir, bytes, config, progress),
        },
      } as unknown as VfsReposService,
      vfsIndex: {
        pdf: {
          startPipeline: async (fileId: string, stage: unknown) => {
            pipelineStarts.push([fileId, stage]);
            eventsAtPipelineStart.push(host.events.map((e) => e.event === 'textbook-import-progress'
              ? `progress:${String((e.payload as Record<string, unknown>).stage)}` : e.event));
          },
          isRunning: () => false,
        },
      } as unknown as VfsIndexService,
    },
  });
}

beforeAll(async () => {
  template = fs.mkdtempSync(path.join(os.tmpdir(), 'textbooks-add-schema-'));
  const source = createStorageService({ baseDir: template, dataLocalDir: template });
  try {
    const report = await source.migrations.runAll();
    expect(report.success, report.error ?? '').toBe(true);
  } finally { source.dispose(); }
}, 120_000);
afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'textbooks-add-'));
  fs.cpSync(template, root, { recursive: true });
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  conn = storage.database('vfs');
  database = {
    getConnSafe: () => conn,
    blobsDir: () => path.join(root, 'vfs_blobs'),
  } as unknown as VfsDatabase;
  textbooks = new TextbookRepo();
  folders = new FolderRepo();
  pipelineStarts = [];
  eventsAtPipelineStart = [];
  renderImpl = async () => ({ previewJson: null, extractedText: null, pageCount: 0 });
  host = await startHost(true);
}, 60_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  fs.rmSync(root, { recursive: true, force: true });
}, 60_000);

function write(name: string, content: string | Uint8Array): string {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function sha(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function progressEvents(): Array<Record<string, unknown>> {
  return host.eventsNamed('textbook-import-progress') as Array<Record<string, unknown>>;
}

function stages(): Array<[unknown, unknown, unknown]> {
  return progressEvents().map((e) => [e.stage, e.progress, e.error]);
}

function watchEvents(): Array<[string, unknown]> {
  return host.events.filter((e) => e.event.startsWith('dstu:change')).map((e) => [e.event, e.payload]);
}

function createFolder(id: string): void {
  const now = Date.now();
  folders.createFolder(conn, {
    id, title: '教材', isExpanded: true, isFavorite: false, sortOrder: 0, createdAt: now, updatedAt: now,
  });
}

it('empty sources return [] without touching VFS or emitting events', async () => {
  await host.dispose();
  host = await startHost(false);
  expect(await host.invoke('textbooks_add', { sources: [] })).toEqual([]);
  expect(host.events).toEqual([]);
});

it('missing VFS database is a Configuration error (textbooks.rs:124-127)', async () => {
  await host.dispose();
  host = await startHost(false);
  await expect(host.invoke('textbooks_add', { sources: [write('a.txt', 'x')] })).rejects.toEqual({
    error_type: 'Configuration', message: 'VFS database not configured', details: null,
  });
});

it('imports a text document into a folder with the Rust stage sequence', async () => {
  createFolder('fld_books');
  const content = '第一章\n函数与极限\n';
  const src = write('notes.txt', content);
  const result = await host.invoke('textbooks_add', { sources: [src], folderId: 'fld_books' }) as Array<Record<string, unknown>>;

  expect(result).toHaveLength(1);
  const id = result[0]!.id as string;
  expect(result[0]!).toMatchObject({
    sha256: sha(content), file_name: 'notes.txt', file_path: src, size: Buffer.byteLength(content),
    page_count: 1, status: 'active', favorite: 0, tags_json: '[]', bookmarks_json: '[]', origin_json: null,
  });
  const row = conn.get<Record<string, unknown>>(
    'SELECT blob_hash, extracted_text, page_count, original_path, ocr_pages_json FROM files WHERE id = ?1', [id])!;
  expect(row).toMatchObject({
    blob_hash: sha(content), extracted_text: expect.stringContaining('函数与极限'),
    page_count: 1, original_path: src, ocr_pages_json: null,
  });
  expect(conn.pluck<string>(
    "SELECT folder_id FROM folder_items WHERE item_id = ?1 AND item_type = 'file'", [id])).toBe('fld_books');

  expect(progressEvents().map((e) => [e.file_name, e.stage, e.current_page, e.total_pages, e.progress, e.error])).toEqual([
    ['notes.txt', 'hashing', null, null, 5, null],
    ['notes.txt', 'copying', null, null, 10, null],
    ['notes.txt', 'parsing', null, null, 15, null],
    ['notes.txt', 'saving', null, null, 90, null],
    ['notes.txt', 'indexing', null, null, 95, null],
    ['notes.txt', 'done', null, null, 100, null],
  ]);
  expect(watchEvents()).toEqual([
    [`dstu:change:/${id}`, { type: 'created', path: `/${id}` }],
    ['dstu:change', { type: 'created', path: `/${id}` }],
  ]);
  // watch 事件在 indexing 之后、done 之前（textbooks.rs:684-688）
  const order = host.events.map((e) => (e.event === 'textbook-import-progress'
    ? (e.payload as { stage: string }).stage : e.event));
  expect(order.slice(-4)).toEqual(['indexing', `dstu:change:/${id}`, 'dstu:change', 'done']);
  // Tauri 2 `Window::emit` 是全局广播（target Any），进度与 dstu:change 一致
  expect(host.events.every((e) => JSON.stringify(e.target) === JSON.stringify({ kind: 'Any' }))).toBe(true);
  // 非 PDF 不启动流水线
  expect(pipelineStarts).toEqual([]);
});

it('skips unsupported and unrecognized files and emits the all-skipped summary', async () => {
  const exe = write('setup.exe', 'MZ\u0000binary');
  const unknown = write('blob', Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe, 0xff, 0x00, 0x10]));
  expect(await host.invoke('textbooks_add', { sources: [exe, unknown] })).toEqual([]);
  expect(progressEvents().map((e) => [e.file_name, e.stage, e.progress, e.error])).toEqual([
    ['setup.exe', 'error', 0, '不支持的文件格式: exe'],
    ['blob', 'error', 0, '无法识别文件格式，请确认文件类型后重试'],
    ['', 'error', 0, 'setup.exe: 不支持的文件格式 (exe); blob: 无法识别文件格式'],
  ]);
  expect(conn.pluck<number>('SELECT COUNT(*) FROM files')).toBe(0);
});

it('rejects files over the 200MB import limit before hashing', async () => {
  const big = path.join(root, 'huge.pdf');
  fs.writeFileSync(big, '%PDF-1.7');
  fs.truncateSync(big, 201 * 1024 * 1024); // 稀疏文件
  expect(await host.invoke('textbooks_add', { sources: [big] })).toEqual([]);
  expect(stages()).toEqual([
    ['error', 0, '文件过大，上限 200MB'],
    ['error', 0, 'huge.pdf: 文件过大 (201.0MB，上限 200MB)'],
  ]);
});

it('reports unreadable sources as read failures and keeps going', async () => {
  const missing = path.join(root, 'missing.txt');
  const ok = write('ok.md', '# ok');
  const result = await host.invoke('textbooks_add', { sources: [missing, ok] }) as unknown[];
  expect(result).toHaveLength(1);
  const events = progressEvents();
  expect(events[0]!).toMatchObject({ file_name: 'missing.txt', stage: 'hashing', progress: 5 });
  expect(events[1]!).toMatchObject({
    file_name: 'missing.txt', stage: 'error', progress: 0,
    error: expect.stringMatching(/^读取文件失败: 读取文件失败: .*missing\.txt \(/),
  });
  // 有成功项时不发汇总
  expect(events.filter((e) => e.file_name === '')).toEqual([]);
});

it('rejects a .pdf without the PDF header before storing any blob', async () => {
  const bad = write('bad.pdf', 'not a pdf at all');
  expect(await host.invoke('textbooks_add', { sources: [bad] })).toEqual([]);
  expect(progressEvents().map((e) => [e.stage, e.current_page, e.progress, e.error])).toEqual([
    ['hashing', null, 5, null],
    ['copying', null, 10, null],
    ['rendering', 0, 15, null],
    ['error', null, 0, "文件 'bad.pdf' 不是有效的 PDF 文档（缺少 PDF 文件头）"],
    ['error', null, 0, "bad.pdf: 文件 'bad.pdf' 不是有效的 PDF 文档（缺少 PDF 文件头）"],
  ]);
  expect(conn.pluck<number>('SELECT COUNT(*) FROM blobs')).toBe(0);
  expect(conn.pluck<number>('SELECT COUNT(*) FROM files')).toBe(0);
});

it('rejects an encrypted PDF with the DocumentParser message', async () => {
  const enc = write('locked.pdf', '%PDF-1.7\n1 0 obj << /Encrypt 2 0 R >> endobj\n');
  expect(await host.invoke('textbooks_add', { sources: [enc] })).toEqual([]);
  expect(progressEvents()[3]!).toMatchObject({
    stage: 'error',
    error: "文档已加密: 文件 'locked.pdf' 是加密的 PDF 文档，请先解除密码保护后再上传",
  });
  expect(conn.pluck<number>('SELECT COUNT(*) FROM blobs')).toBe(0);
});

it('imports a PDF with rendering progress and starts the pipeline from OCR', async () => {
  const preview = { pages: [{ pageIndex: 0 }], totalPages: 2 };
  renderImpl = async (_c, _dir, _bytes, _config, progress) => {
    progress?.(1, 2);
    progress?.(2, 2);
    return { previewJson: preview, extractedText: '第一页\f第二页', pageCount: 2 };
  };
  const bytes = '%PDF-1.7\n%%EOF\n';
  const src = write('Calculus.pdf', bytes);
  const result = await host.invoke('textbooks_add', { sources: [src] }) as Array<Record<string, unknown>>;
  const id = result[0]!.id as string;
  expect(result[0]!).toMatchObject({ file_name: 'Calculus.pdf', page_count: 2, sha256: sha(bytes) });
  expect(progressEvents().map((e) => [e.stage, e.current_page, e.total_pages, e.progress])).toEqual([
    ['hashing', null, null, 5],
    ['copying', null, null, 10],
    ['rendering', 0, null, 15],
    ['rendering', 1, 2, 50],
    ['rendering', 2, 2, 85],
    ['saving', null, null, 90],
    ['indexing', null, null, 95],
    ['done', null, null, 100],
  ]);
  const row = conn.get<Record<string, unknown>>(
    'SELECT preview_json, extracted_text, page_count, processing_error FROM files WHERE id = ?1', [id])!;
  expect(JSON.parse(row.preview_json as string)).toEqual(preview);
  expect(row).toMatchObject({ extracted_text: '第一页\f第二页', page_count: 2, processing_error: null });
  await vi.waitFor(() => expect(pipelineStarts).toEqual([[id, 'ocr_processing']]));
});

it('starts the PDF pipeline in a spawned task after dstu:change and done (tokio::spawn)', async () => {
  // G3 textbooks.add.pdf_render_error_recorded (Rust A1/A2): dstu:change → done → pipeline events.
  const src = write('corrupt.pdf', '%PDF-1.7\n%%EOF\n');
  await host.invoke('textbooks_add', { sources: [src] });
  await vi.waitFor(() => expect(eventsAtPipelineStart).toHaveLength(1));
  expect(eventsAtPipelineStart[0]!.slice(-2)).toEqual(['dstu:change', 'progress:done']);
});

it('stores a PDF whose rendering failed with an explicit error status', async () => {
  renderImpl = async () => { throw new Error('pdfium exploded'); };
  const src = write('broken.pdf', '%PDF-1.4 broken');
  const result = await host.invoke('textbooks_add', { sources: [src] }) as Array<Record<string, unknown>>;
  const id = result[0]!.id as string;
  expect(result[0]!.page_count).toBeNull();
  const row = conn.get<Record<string, unknown>>(
    'SELECT processing_status, processing_error, preview_json, blob_hash FROM files WHERE id = ?1', [id])!;
  expect(row).toEqual({
    processing_status: 'error',
    processing_error: 'PDF 渲染失败，预览与文本提取不可用：pdfium exploded。可尝试删除后重新导入，或检查 PDF 是否损坏/加密',
    preview_json: null,
    blob_hash: sha('%PDF-1.4 broken'),
  });
  await vi.waitFor(() => expect(pipelineStarts).toEqual([[id, 'ocr_processing']]));
});

it('restores a deleted duplicate, renames it, heals its blob and returns the pre-restore snapshot', async () => {
  createFolder('fld_target');
  const bytes = '%PDF-1.7 same content';
  const created = textbooks.createTextbook(conn, sha(bytes), 'Old Name.pdf', bytes.length, null, null);
  textbooks.deleteTextbook(conn, created.id);
  const src = write('New Name.pdf', bytes);

  const result = await host.invoke('textbooks_add', { sources: [src], folderId: 'fld_target' }) as Array<Record<string, unknown>>;
  // textbooks.rs:362 推入的是 get_by_sha256 时的快照（恢复/重命名之前）
  expect(result).toHaveLength(1);
  expect(result[0]!).toMatchObject({ id: created.id, file_name: 'Old Name.pdf', status: 'deleted' });

  const row = conn.get<Record<string, unknown>>(
    'SELECT status, file_name, blob_hash FROM files WHERE id = ?1', [created.id])!;
  expect(row).toEqual({ status: 'active', file_name: 'New Name.pdf', blob_hash: sha(bytes) });
  expect(conn.pluck<string>(
    "SELECT folder_id FROM folder_items WHERE item_id = ?1 AND item_type = 'file'", [created.id])).toBe('fld_target');
  expect(watchEvents()).toEqual([
    [`dstu:change:/${created.id}`, { type: 'restored', path: `/${created.id}` }],
    ['dstu:change', { type: 'restored', path: `/${created.id}` }],
  ]);
  expect(stages()).toEqual([['hashing', 5, null], ['done', 100, null]]);
  await vi.waitFor(() => expect(pipelineStarts).toEqual([[created.id, 'ocr_processing']]));
  expect(conn.pluck<number>('SELECT COUNT(*) FROM files')).toBe(1);
});

it('re-importing an active textbook emits created and does not restore or rename', async () => {
  const content = 'same text';
  const first = write('a.txt', content);
  const [tb] = await host.invoke('textbooks_add', { sources: [first] }) as [Record<string, unknown>];
  host.events.length = 0;
  const second = write('b.txt', content);
  const again = await host.invoke('textbooks_add', { sources: [second] }) as Array<Record<string, unknown>>;
  expect(again).toEqual([tb]);
  expect(conn.pluck<string>('SELECT file_name FROM files WHERE id = ?1', [tb.id as string])).toBe('a.txt');
  expect(watchEvents()).toEqual([
    [`dstu:change:/${tb.id as string}`, { type: 'created', path: `/${tb.id as string}` }],
    ['dstu:change', { type: 'created', path: `/${tb.id as string}` }],
  ]);
  expect(stages()).toEqual([['hashing', 5, null], ['done', 100, null]]);
});

it('names opaque document ids as 导入文档_<UTC timestamp>.<ext>', async () => {
  const src = write('446', '%PDF-1.7 opaque');
  const result = await host.invoke('textbooks_add', { sources: [src] }) as Array<Record<string, unknown>>;
  expect(result[0]!.file_name).toMatch(/^导入文档_\d{8}_\d{6}\.pdf$/);
  expect(progressEvents()[0]!.file_name).toBe(result[0]!.file_name);
});

it('retries transient lock errors on insert and skips the file on a hard failure', async () => {
  const original = textbooks.createTextbookWithPreview.bind(textbooks);
  let lockedFailures = 2;
  let hardFailure = false;
  textbooks.createTextbookWithPreview = (...args: Parameters<TextbookRepo['createTextbookWithPreview']>) => {
    if (hardFailure) throw new Error('Database error: UNIQUE constraint failed: files.sha256');
    if (lockedFailures > 0) { lockedFailures -= 1; throw new Error('Database error: database is locked'); }
    return original(...args);
  };
  const ok = await host.invoke('textbooks_add', { sources: [write('retry.txt', 'retry')] }) as unknown[];
  expect(ok).toHaveLength(1);
  expect(lockedFailures).toBe(0);

  host.events.length = 0;
  hardFailure = true;
  expect(await host.invoke('textbooks_add', { sources: [write('hard.txt', 'hard')] })).toEqual([]);
  expect(stages().slice(-2)).toEqual([
    ['error', 0, '入库失败: Database error: UNIQUE constraint failed: files.sha256'],
    ['error', 0, 'hard.txt: 入库失败: Database error: UNIQUE constraint failed: files.sha256'],
  ]);
}, 20_000);

/** stored-only ZIP（CRC 置 0；EPUB 解析只读条目名与内容）。 */
function zipOf(parts: Array<[string, string]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of parts) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x0403_4b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x0201_4b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x0605_4b50, 0);
  eocd.writeUInt16LE(parts.length, 8);
  eocd.writeUInt16LE(parts.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

function twoChapterEpub(): Buffer {
  const chapter = (title: string, body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head>
<body><h1>${title}</h1><p>${body}</p></body></html>`;
  return zipOf([
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`],
    ['OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">textbooks-add-epub</dc:identifier><dc:title>高数</dc:title>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch1"/><itemref idref="ch2"/></spine>
</package>`],
    ['OEBPS/ch1.xhtml', chapter('第一章 极限', 'sin(x)/x 的极限为 1。')],
    ['OEBPS/ch2.xhtml', chapter('第二章 导数', '导数是变化率。')],
  ]);
}

it('epub page-level text is written to ocr_pages_json with the joined text (textbooks.rs:503-515,635-646)', async () => {
  const src = write('高数.epub', twoChapterEpub());
  const result = await host.invoke('textbooks_add', { sources: [src] }) as Array<Record<string, unknown>>;
  expect(result).toHaveLength(1);
  const id = result[0]!.id as string;
  const row = conn.get<{ ocr_pages_json: string | null; extracted_text: string; page_count: number;
    updated_at: string }>(
    'SELECT ocr_pages_json, extracted_text, page_count, updated_at FROM files WHERE id = ?1', [id])!;
  expect(row.ocr_pages_json).not.toBeNull();
  const pages = JSON.parse(row.ocr_pages_json!) as string[];
  expect(pages.length).toBeGreaterThan(0);
  expect(row.page_count).toBe(pages.length);
  expect(result[0]!.page_count).toBe(pages.length);
  expect(row.extracted_text).toBe(pages.join('\n\n').trim());
  expect(row.extracted_text).toContain('sin(x)/x');
  expect(row.extracted_text).toContain('导数是变化率');
  // UPDATE 只写 ocr_pages_json，不动 updated_at（与返回快照一致）
  expect(row.updated_at).toBe(result[0]!.updated_at);
  expect(stages().map(([stage]) => stage)).toEqual(['hashing', 'copying', 'parsing', 'saving', 'indexing', 'done']);
});

it('render progress follows the Rust f32/u8 arithmetic', () => {
  expect(renderProgressPercent(0, 10)).toBe(15);
  expect(renderProgressPercent(1, 3)).toBe(38);
  expect(renderProgressPercent(10, 10)).toBe(85);
  expect(renderProgressPercent(0, 0)).toBe(15); // NaN as u8 = 0
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createHttpService } from '../../../platform/http/index.ts';
import * as vfsReposApi from '../../vfs-repos/api.ts';
import plugin from '../index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
// boundary-allow cross-plugin-impl: install real L10 notes plugin required by vfs
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: install real L11 vfs-repos plugin; files/blobs are written only through it
import reposPlugin from '../../vfs-repos/index.ts';

interface FileResult {
  sourceId: string; resourceHash: string; isNew: boolean;
  file: { id: string; fileName: string; size: number; fileType: string; extractedText?: string };
  ocrStatus?: { performed: boolean; skipReason?: string; totalPages: number; allSuccess: boolean; message: string };
  indexStatus?: { queued: boolean; unitsCreated: number; message: string };
}
interface PaperResult {
  success: boolean; fileId: string | null; fileName: string | null; sizeBytes: number | null;
  pageCount: number | null; error: string | null;
}

// L11 0a3d703ad publishes attachmentProcessing together with mediaKind; both commands need it.
const ownerPublished = typeof (vfsReposApi as unknown as { mediaKind?: unknown }).mediaKind === 'function';
// 1x1 transparent PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe.skipIf(!ownerPublished)('vfs_upload_file / vfs_download_paper (production entry)', { timeout: 60_000 }, () => {
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let host: TestHost;
  const config = new Map<string, string>();
  const settings = new Map<string, string>();
  let previousDispatcher: Dispatcher;
  let mock: MockAgent;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-upload-file-'));
    storage = createStorageService({ baseDir: root, dataLocalDir: root });
    const report = await storage.migrations.runAll();
    expect(report.success, report.error ?? '').toBe(true);
    host = await createTestHost({ plugins: [pathsPlugin, notesPlugin, reposPlugin, indexPlugin, plugin], provide: {
      storage,
      memoryConfig: { get: (key: string) => config.get(key) ?? null, set: (key: string, value: string) => { config.set(key, value); } },
      settings: { get: (key: string) => settings.get(key) ?? null },
      // L18 docs double: only is_plain_text_code_extension is consulted (extensions outside the handler list)
      docs: { isPlainTextCodeExtension: (ext: string) => ['ts', 'py', 'rs'].includes(ext) },
      // 下载走 ctx.http；传输层用全局 fetch，undici MockAgent 才能拦截
      http: createHttpService({
        transport: (url, init) => fetch(url, {
          method: init.method,
          headers: init.headers,
          redirect: init.redirect,
          ...(init.signal ? { signal: init.signal } : {}),
        }),
      }),
    }, app: { dataDir: root } });
    previousDispatcher = getGlobalDispatcher();
    mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
  }, 120_000);
  afterEach(() => { settings.clear(); });
  afterAll(async () => {
    setGlobalDispatcher(previousDispatcher);
    await mock?.close();
    await host?.dispose(); storage?.dispose(); fs.rmSync(root, { recursive: true, force: true });
  });
  const upload = (params: Record<string, unknown>) => host.invoke<FileResult>('vfs_upload_file', { params });
  const paper = (params: Record<string, unknown>) => host.invoke<PaperResult>('vfs_download_paper', { params });

  it('rejects bad base64 and unsupported types with the Rust messages (handlers.rs:2151-2170)', async () => {
    await expect(upload({ name: 'a.txt', mimeType: 'text/plain', base64Content: '***' }))
      .rejects.toContain('Base64 decode failed');
    await expect(upload({ name: 'a.exe', mimeType: 'application/x-msdownload', base64Content: 'AAAA' }))
      .rejects.toBe("Invalid argument 'mime_type': UNSUPPORTED_FILE_TYPE: 不支持的文件类型 .exe (文件: a.exe, MIME: application/x-msdownload)");
  });

  it('creates a file with index status, then reuses it by sha256 without statuses (handlers.rs:2197-2252)', async () => {
    const base64Content = Buffer.from('vfs upload file body').toString('base64');
    const first = await upload({ name: 'n.txt', mimeType: 'text/plain', base64Content });
    expect(first.isNew).toBe(true);
    expect(first.sourceId).toBe(first.file.id);
    expect(first.file.fileType).toBe('document');
    expect(first.ocrStatus).toBeUndefined();
    expect(first.indexStatus?.message).toMatch(/^(已加入索引队列|索引失败，已加入后台重试队列: )/);
    expect(config.get('attachment_root_folder_id')).toBeTruthy();
    // Small non-image uploads keep their bytes: a real blob row/path now backs
    // the file (previously an empty inline row dropped the payload).
    const conn = host.ctx.vfsDatabase.getConnSafe();
    const blobHash = conn.pluck<string | null>('SELECT blob_hash FROM files WHERE id = ?1', [first.sourceId]);
    expect(blobHash).toBe(first.resourceHash);
    const relativePath = conn.pluck<string | null>('SELECT relative_path FROM blobs WHERE hash = ?1', [blobHash!]);
    expect(relativePath).toBeTruthy();
    expect(relativePath!.endsWith('.txt')).toBe(true);
    expect(fs.readFileSync(path.join(host.ctx.vfsDatabase.blobsDir(), relativePath!)).toString('utf8'))
      .toBe('vfs upload file body');
    const second = await upload({ name: 'n.txt', mimeType: 'text/plain', base64Content });
    expect(second).toMatchObject({ isNew: false, sourceId: first.sourceId });
    expect(second.ocrStatus).toBeUndefined();
    expect(second.indexStatus).toBeUndefined();
  });

  it('reports pending image OCR per ocr.* settings (handlers.rs:2546-2646)', async () => {
    const image = await upload({ name: 'p.png', mimeType: 'image/png', base64Content: PNG });
    expect(image.file.fileType).toBe('image');
    expect(image.ocrStatus).toEqual({ performed: false, successCount: 0, failedCount: 0, blobMissingCount: 0,
      totalPages: 0, allSuccess: false, message: '图片 OCR 将由 Pipeline 处理' });
    settings.set('ocr.images', 'FALSE');
    const other = Buffer.from(PNG, 'base64');
    other.writeUInt8(other.readUInt8(other.length - 1) ^ 1, other.length - 1); // different sha256, same type
    const noOcr = await upload({ name: 'q.png', mimeType: 'image/png', base64Content: other.toString('base64') });
    expect(noOcr.ocrStatus).toBeUndefined();
  });

  it('enforces https, HTTP status and the %PDF signature (handlers.rs:7353-7401)', async () => {
    await expect(paper({ url: 'http://example.org/a.pdf', title: 't' })).rejects.toBe('Only HTTPS URLs are allowed');
    const pool = mock.get('https://papers.test');
    pool.intercept({ path: '/missing.pdf', method: 'GET' }).reply(404, 'nope');
    await expect(paper({ url: 'https://papers.test/missing.pdf', title: 't' })).rejects.toBe('HTTP 404');
    pool.intercept({ path: '/html', method: 'GET' }).reply(200, '<html>');
    await expect(paper({ url: 'https://papers.test/html', title: 't' }))
      .rejects.toBe('Downloaded file is not a valid PDF');
  });

  it('downloads through redirects, sanitizes the title and dedupes by sha256 (handlers.rs:7403-7586)', async () => {
    const pdf = Buffer.from('%PDF-1.4\n% minimal body for signature check\n%%EOF\n');
    const pool = mock.get('https://papers.test');
    pool.intercept({ path: '/r', method: 'GET', headers: { 'user-agent': 'DeepStudent/1.0 (Academic Paper Save)' } })
      .reply(302, '', { headers: { location: 'https://papers.test/p.pdf' } });
    pool.intercept({ path: '/p.pdf', method: 'GET' }).reply(200, pdf);
    const saved = await paper({ url: 'https://papers.test/r', title: 'A/B: c?' });
    expect(saved).toMatchObject({ success: true, fileName: 'A_B_ c_.pdf', sizeBytes: pdf.length, error: null });
    expect(saved.fileId).toMatch(/^file_/);
    pool.intercept({ path: '/p.pdf', method: 'GET' }).reply(200, pdf);
    const again = await paper({ url: 'https://papers.test/p.pdf', title: 'x.PDF' });
    // reuse branch: fileName None, page_count from the existing row
    expect(again).toMatchObject({ success: true, fileId: saved.fileId, fileName: null, sizeBytes: pdf.length, error: null });
  });
});

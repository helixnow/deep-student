import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type { VfsResourceRecord } from '../repository/index-units.ts';
import { VfsOcrRecovery } from '../src/ocr-recovery.ts';
import { bindVfsTableOwners } from '../repository/owners.ts';
import { realOwner } from './support/real-owner.ts';

interface Harness {
  db: DatabaseHandle;
  base: string;
  storage: ReturnType<typeof createStorageService>;
}

const harnesses: Harness[] = [];
const blobFiles = new Map<string, string>();
let templateDir = '';

beforeAll(async () => {
  templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-ocr-recovery-template-'));
  const storage = createStorageService({
    baseDir: templateDir,
    dataLocalDir: path.join(templateDir, 'local'),
  });
  const report = await storage.migrations.runAll();
  if (!report.success) throw new Error('vfs migration failed');
  storage.dispose();
}, 180_000);

function freshDb(): Harness {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-ocr-recovery-'));
  fs.cpSync(templateDir, base, { recursive: true });
  const storage = createStorageService({ baseDir: base, dataLocalDir: path.join(base, 'local') });
  const harness = { db: storage.database('vfs'), base, storage };
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (harnesses.length > 0) {
    const harness = harnesses.pop()!;
    harness.storage.dispose();
    fs.rmSync(harness.base, { recursive: true, force: true });
  }
  blobFiles.clear();
});

/** 生产由 `ctx.files.readBytes` 提供；测试直接走 Node 的测试夹具文件。 */
const readBytes = async (file: string): Promise<Uint8Array> => new Uint8Array(fs.readFileSync(file));

function blob(hash: string, text: string): string {
  const filePath = path.join(os.tmpdir(), `vfs-ocr-recovery-${process.pid}-${hash}`);
  fs.writeFileSync(filePath, text);
  blobFiles.set(hash, filePath);
  return hash;
}

/**
 * Formal L11 provider members on the test's own connection; only the blob path
 * lookup is a test-local temp-file fixture.
 */
function repositories(db: DatabaseHandle): VfsReposService {
  const owner = realOwner();
  const repos = {
    blobs: {
      getBlobPath: (_db: unknown, _dir: unknown, hash: string) => blobFiles.get(hash) ?? null,
    },
    files: owner.files,
    exams: owner.exams,
    resources: owner.resources,
  } as unknown as VfsReposService;
  bindVfsTableOwners(db, repos);
  return repos;
}

function resource(overrides: Partial<VfsResourceRecord> = {}): VfsResourceRecord {
  return {
    id: 'res_ocr',
    hash: 'h',
    resourceType: 'file',
    sourceId: 'file_ocr',
    sourceTable: 'files',
    storageMode: 'external',
    data: null,
    metadataJson: null,
    ...overrides,
  };
}

function insertFile(db: DatabaseHandle, previewJson: string | null, ocrPagesJson: string | null = null): void {
  db.run(
    `INSERT INTO resources (id, hash, type, storage_mode, data, created_at, updated_at)
     VALUES ('res_ocr', 'h', 'file', 'external', NULL, 1, 1)`,
  );
  db.run(
    `INSERT INTO blobs (hash, relative_path, size, mime_type, ref_count, created_at)
     VALUES ('page_1', 'objects/1', 4, 'image/png', 1, 1),
            ('page_2', 'objects/2', 4, 'image/png', 1, 1)`,
  );
  db.run(
    `INSERT INTO files (id, resource_id, blob_hash, sha256, file_name, size, "type", mime_type,
       status, created_at, updated_at, preview_json, ocr_pages_json, processing_progress)
     VALUES ('file_ocr', 'res_ocr', NULL, 'sha', 'scan.pdf', 12, 'file', 'application/pdf',
       'active', 1, 1, ?1, ?2, '{"stage":"ocr_processing","percent":20,"readyModes":["text"]}')`,
    [previewJson, ocrPagesJson],
  );
}

const preview = JSON.stringify({
  pages: [
    { pageIndex: 0, blobHash: 'page_1', width: 10, height: 10, mimeType: 'image/png' },
    { pageIndex: 1, blobHash: 'page_2', width: 10, height: 10, mimeType: 'image/png' },
  ],
  renderDpi: 150,
  totalPages: 2,
  renderedAt: '2026-01-01T00:00:00.000Z',
});

describe('Rust indexing.rs try_auto_ocr recovery', () => {
  it('R12-08 try_auto_ocr_pdf_pages preserves and orders exact preview indices in persisted OCR', async () => {
    const { db } = freshDb();
    blob('page_1', 'first page');
    blob('page_2', 'second page');
    insertFile(db, preview.replace('"pageIndex":0', '"pageIndex":9007199254740993')
      .replace('"pageIndex":1', '"pageIndex":9007199254740992'));
    const recovery = new VfsOcrRecovery({ readBytes, db, blobsDir: '/unused', repositories: () => repositories(db),
      provider: { available: async () => true, recognize: async (_url, bytes) => Buffer.from(bytes).toString() } });
    expect(await recovery.recover(resource(), () => undefined)).toBe('second page\n\nfirst page');
    const raw = String(db.pluck("SELECT ocr_pages_json FROM files WHERE id = 'file_ocr'"));
    expect(raw).toContain('"page_index":9007199254740993');
    expect(raw).toContain('"page_index":9007199254740992');
    expect(raw.indexOf('"page_index":9007199254740992')).toBeLessThan(raw.indexOf('"page_index":9007199254740993'));
  });
  it('try_auto_ocr_pdf_pages: blank preview skips, malformed preview is an error, zero pages skips on its own (indexing.rs:3526-3551)', async () => {
    const infos: string[] = [];
    const logger = {
      debug: () => undefined, warn: () => undefined, error: () => undefined,
      info: (message: string) => { infos.push(message); },
    };
    const provider = { available: async () => true, recognize: async (): Promise<string> => { throw new Error('OCR must not run'); } };
    const recover = async (previewJson: string): Promise<string | null> => {
      const { db } = freshDb();
      insertFile(db, previewJson);
      const recovery = new VfsOcrRecovery({ readBytes, db, blobsDir: '/unused', repositories: () => repositories(db), provider, logger });
      return recovery.recover(resource(), () => undefined);
    };

    expect(await recover(' \n')).toBeNull();
    expect(infos.at(-1)).toBe(
      '[try_auto_ocr_pdf_pages] No preview_json for file file_ocr (resource res_ocr), cannot OCR without rendered pages');

    await expect(recover('{"pages":[')).rejects.toThrow(
      /^Failed to parse preview_json for file file_ocr: EOF while parsing a list at line 1 column 10$/);

    expect(await recover('{"pages":[],"renderDpi":150,"totalPages":0,"renderedAt":"x"}')).toBeNull();
    expect(infos.at(-1)).toBe('[try_auto_ocr_pdf_pages] preview_json has 0 pages for file file_ocr, skipping');
  });

  it('OCRs preview pages, persists ocr_pages_json/ocr_text and emits progress', async () => {
    const { db } = freshDb();
    blob('page_1', 'first page');
    blob('page_2', 'second page');
    insertFile(db, preview);
    const calls: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const recovery = new VfsOcrRecovery({
      readBytes,
      db,
      blobsDir: '/unused',
      repositories: () => repositories(db),
      provider: {
        available: async () => true,
        recognize: async (dataUrl) => {
          calls.push(dataUrl);
          return dataUrl.includes(Buffer.from('first page').toString('base64'))
            ? '第一页文本' : '第二页文本';
        },
      },
    });

    const text = await recovery.recover(resource(), (event) => events.push(event));

    expect(calls).toHaveLength(2);
    expect(text).toBe('第一页文本\n\n第二页文本');
    expect(String(db.pluck('SELECT resources.ocr_text FROM resources WHERE id = ?1', ['res_ocr'])))
      .toBe('第一页文本\n\n第二页文本');
    const ocrJson = JSON.parse(String(db.pluck(
      "SELECT ocr_pages_json FROM files WHERE id = 'file_ocr'",
    ))) as { total_pages: number; pages: Array<{ page_index: number; blocks: Array<{ text: string }> }> };
    expect(ocrJson.total_pages).toBe(2);
    expect(ocrJson.pages.map((page) => page.blocks[0]!.text)).toEqual(['第一页文本', '第二页文本']);
    expect(events.map((event) => event['type'])).toEqual([
      'auto_ocr_started', 'auto_ocr_page', 'auto_ocr_page', 'auto_ocr_completed',
    ]);
    expect(events[3]).toMatchObject({ success: true, successCount: 2, failCount: 0, totalPages: 2 });
    const progress = JSON.parse(String(db.pluck(
      "SELECT processing_progress FROM files WHERE id = 'file_ocr'",
    ))) as { readyModes: string[] };
    expect(progress.readyModes).toEqual(['text', 'ocr']);
  });

  it('V03-01 auto-OCR readiness emits media/pdf-processing-progress before auto_ocr_completed (indexing.rs:3814-3831)', async () => {
    const { db } = freshDb();
    blob('page_1', 'first page');
    blob('page_2', 'second page');
    insertFile(db, preview);
    const timeline: string[] = [];
    const backend: Array<{ event: string; payload: unknown }> = [];
    const recovery = new VfsOcrRecovery({
      readBytes,
      db, blobsDir: '/unused', repositories: () => repositories(db),
      provider: { available: async () => true, recognize: async () => '识别文字' },
      events: { emit: (event, payload) => { timeline.push(event); backend.push({ event, payload }); } },
    });

    await recovery.recover(resource(), (event) => timeline.push(String(event['type'])));

    expect(timeline).toEqual([
      'auto_ocr_started', 'auto_ocr_page', 'auto_ocr_page',
      'media-processing-progress', 'pdf-processing-progress', 'auto_ocr_completed',
    ]);
    const expected = {
      fileId: 'file_ocr',
      status: { stage: 'ocr_processing', percent: 20, readyModes: ['text', 'ocr'] },
      mediaType: 'pdf',
    };
    expect(backend).toEqual([
      { event: 'media-processing-progress', payload: expected },
      { event: 'pdf-processing-progress', payload: expected },
    ]);
    expect(Object.keys(backend[0]!.payload as object)).toEqual(['fileId', 'status', 'mediaType']);
  });

  it('V03-01 already ocr-ready progress is left as is but still emits both progress events', async () => {
    const { db } = freshDb();
    blob('page_1', 'first page');
    blob('page_2', 'second page');
    insertFile(db, preview);
    const stored = '{"stage":"completed","percent":100,"readyModes":["text","ocr"],"mediaType":"pdf"}';
    db.run(`UPDATE files SET processing_progress = ?1 WHERE id = 'file_ocr'`, [stored]);
    const backend: Array<{ event: string; payload: unknown }> = [];
    const recovery = new VfsOcrRecovery({
      readBytes,
      db, blobsDir: '/unused', repositories: () => repositories(db),
      provider: { available: async () => true, recognize: async () => '识别文字' },
      events: { emit: (event, payload) => backend.push({ event, payload }) },
    });

    await recovery.recover(resource(), () => undefined);

    expect(String(db.pluck("SELECT processing_progress FROM files WHERE id = 'file_ocr'"))).toBe(stored);
    const expected = {
      fileId: 'file_ocr',
      status: { stage: 'completed', percent: 100, readyModes: ['text', 'ocr'], mediaType: 'pdf' },
      mediaType: 'pdf',
    };
    expect(backend).toEqual([
      { event: 'media-processing-progress', payload: expected },
      { event: 'pdf-processing-progress', payload: expected },
    ]);
  });

  it('V03-01 unparsable progress is skipped without writeback or progress events (indexing.rs:3799)', async () => {
    const { db } = freshDb();
    blob('page_1', 'first page');
    blob('page_2', 'second page');
    insertFile(db, preview);
    db.run(`UPDATE files SET processing_progress = 'not json' WHERE id = 'file_ocr'`);
    const backend: string[] = [];
    const events: string[] = [];
    const recovery = new VfsOcrRecovery({
      readBytes,
      db, blobsDir: '/unused', repositories: () => repositories(db),
      provider: { available: async () => true, recognize: async () => '识别文字' },
      events: { emit: (event) => backend.push(event) },
    });

    expect(await recovery.recover(resource(), (event) => events.push(String(event['type']))))
      .toBe('识别文字\n\n识别文字');

    expect(String(db.pluck("SELECT processing_progress FROM files WHERE id = 'file_ocr'"))).toBe('not json');
    expect(backend).toEqual([]);
    expect(events.at(-1)).toBe('auto_ocr_completed');
  });

  it('X6-UD-0089 OCR readiness writeback preserves exact persisted page counters', async () => {
    const { db } = freshDb();
    blob('page_1', 'first page');
    blob('page_2', 'second page');
    insertFile(db, preview);
    db.run(`UPDATE files SET processing_progress = ?1 WHERE id = 'file_ocr'`, [
      '{"stage":"ocr_processing","current_page":9007199254740993,"total_pages":18446744073709551615,"percent":-0.0,"ready_modes":["image"]}',
    ]);
    const recovery = new VfsOcrRecovery({
      readBytes,
      db, blobsDir: '/unused', repositories: () => repositories(db),
      provider: { available: async () => true, recognize: async () => '识别文字' },
    });
    expect(await recovery.recover(resource(), () => undefined)).toBe('识别文字\n\n识别文字');
    const persisted = String(db.pluck("SELECT processing_progress FROM files WHERE id = 'file_ocr'"));
    expect(persisted).toContain('"currentPage":9007199254740993');
    expect(persisted).toContain('"totalPages":18446744073709551615');
    expect(persisted).toContain('"percent":-0.0');
    expect(JSON.parse(persisted).readyModes).toEqual(['image', 'ocr']);
  });

  it('R12-06 resource cache failure warns but retains OCR text and completion (indexing.rs:3776-3786)', async () => {
    const { db } = freshDb();
    blob('page_1', 'first page');
    blob('page_2', 'second page');
    insertFile(db, preview);
    const owner = repositories(db);
    db.exec(`CREATE TEMP TRIGGER reject_recovery_cache BEFORE UPDATE OF ocr_text ON resources
      WHEN NEW.id = 'res_ocr'
      BEGIN SELECT RAISE(ABORT, 'cache rejected'); END`);
    const before = db.get('SELECT * FROM resources WHERE id = ?', ['res_ocr']);
    const warnings: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const recovery = new VfsOcrRecovery({
      readBytes,
      db, blobsDir: '/unused', repositories: () => owner,
      provider: { available: async () => true, recognize: async () => '识别文字' },
      logger: {
        debug: () => undefined, info: () => undefined, error: () => undefined,
        warn: (message) => { warnings.push(message); },
      },
    });
    expect(await recovery.recover(resource(), (event) => events.push(event))).toBe('识别文字\n\n识别文字');
    expect(warnings).toContain('[VfsIndexing] Failed to cache ocr_text for resource res_ocr: cache rejected');
    expect(events.at(-1)).toMatchObject({ type: 'auto_ocr_completed', success: true });
    expect(db.pluck("SELECT ocr_text FROM resources WHERE id = 'res_ocr'")).toBeNull();
    expect(db.get('SELECT * FROM resources WHERE id = ?', ['res_ocr'])).toEqual(before);
    expect(JSON.parse(String(db.pluck("SELECT processing_progress FROM files WHERE id = 'file_ocr'"))).readyModes)
      .toEqual(['text', 'ocr']);
    expect(db.pluck("SELECT ocr_pages_json FROM files WHERE id = 'file_ocr'")).toContain('识别文字');
    process.stdout.write(`WP-202 recovery failure RAW ${JSON.stringify({ warnings, events,
      resource: db.get('SELECT * FROM resources WHERE id = ?', ['res_ocr']),
      file: db.get('SELECT ocr_pages_json, processing_progress FROM files WHERE id = ?', ['file_ocr']),
    })}\n`);
  });

  it('caches image OCR without touching resources.updated_at', async () => {
    const { db } = freshDb();
    db.run(
      `INSERT INTO resources (id, hash, type, storage_mode, data, created_at, updated_at)
       VALUES ('res_img', 'h', 'image', 'external', NULL, 1, 42)`,
    );
    db.run(
      `INSERT INTO blobs (hash, relative_path, size, mime_type, ref_count, created_at)
       VALUES ('img_1', 'objects/img_1', 11, 'image/png', 1, 1)`,
    );
    db.run(
      `INSERT INTO files (id, resource_id, blob_hash, sha256, file_name, size, "type", mime_type,
         status, created_at, updated_at, preview_json, ocr_pages_json, processing_progress)
       VALUES ('file_img', 'res_img', 'img_1', 'sha', 'scan.png', 12, 'file', 'image/png',
         'active', 1, 42, NULL, NULL, NULL)`,
    );
    blob('img_1', 'image bytes');
    const recovery = new VfsOcrRecovery({
      readBytes,
      db,
      blobsDir: '/unused',
      repositories: () => repositories(db),
      provider: {
        available: async () => true,
        recognize: async () => '图片文字',
      },
    });

    const text = await recovery.recover(resource({
      id: 'res_img', sourceId: 'file_img', resourceType: 'image',
    }), () => undefined);

    expect(text).toBe('图片文字');
    expect(db.pluck('SELECT ocr_text FROM resources WHERE id = ?1', ['res_img']))
      .toBe('图片文字');
    expect(db.pluck('SELECT updated_at FROM resources WHERE id = ?1', ['res_img']))
      .toBe(42);
  });

  it('reuses valid existing ocr_pages_json without calling OCR', async () => {
    const { db } = freshDb();
    insertFile(db, preview, JSON.stringify({
      total_pages: 2,
      pages: [
        { page_index: 0, blocks: [{ text: '已有第一页', bbox: { x: 0, y: 0, width: 1, height: 1 } }] },
      ],
      completed_at: '2026-01-01T00:00:00.000Z',
    }));
    let calls = 0;
    const recovery = new VfsOcrRecovery({
      readBytes,
      db,
      blobsDir: '/unused',
      repositories: () => repositories(db),
      provider: {
        available: async () => true,
        recognize: async () => { calls += 1; return '重新 OCR'; },
      },
    });

    const text = await recovery.recover(resource(), () => undefined);

    expect(calls).toBe(0);
    expect(text).toContain('已有第一页');
    expect(String(db.pluck('SELECT resources.ocr_text FROM resources WHERE id = ?1', ['res_ocr'])))
      .toContain('已有第一页');
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { testFiles } from './support/files.ts';
import type { Row } from '../../../platform/storage/api.ts';
import plugin from '../index.ts';
import { saveResourceOcrText, updateResourceOcrTextRow } from '../repository/index-content.ts';
import { bindRealOwner } from './support/real-owner.ts';

let template: string;
const cleanup: Array<() => Promise<void>> = [];

beforeAll(async () => {
  template = fs.mkdtempSync('/tmp/opencode/wp202-template-');
  const storage = createStorageService({ baseDir: template, dataLocalDir: path.join(template, 'local') });
  try {
    const report = await storage.migrations.runAll();
    if (!report.success) throw new Error(report.error ?? 'migration failed');
  } finally { storage.dispose(); }
}, 180_000);

afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
afterAll(() => { fs.rmSync(template, { recursive: true, force: true }); });

function fresh() {
  const root = fs.mkdtempSync('/tmp/opencode/wp202-cache-');
  fs.cpSync(template, root, { recursive: true });
  const storage = createStorageService({ baseDir: root, dataLocalDir: path.join(root, 'local') });
  const db = storage.database('vfs');
  const owner = bindRealOwner(db);
  let host: TestHost | undefined;
  cleanup.push(async () => {
    await host?.dispose();
    storage.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { storage, db, owner, setHost: (value: TestHost) => { host = value; } };
}

// indexing.rs:3756-3856: the public indexing service reaches the real recovery,
// L11 owner and F3 SQLite. Only the external OCR response is supplied by the test.
it.each([false, true])('WP-202 public OCR recovery preserves SQL timestamp / raw failure (reject=%s)', async reject => {
  const { storage, db, owner, setHost } = fresh();
  const recognized = '原文 Ω\n第二行  内部空格\uFEFF';
  const host = await createTestHost({ plugins: [plugin], provide: { files: testFiles(storage), 
    storage, vfsRepo: owner,
    llmOcrModels: { inspectFreeTextOcrAvailable: async () => true, getFreeTextOcrCandidatesByPriority: async () => [] },
    llmOcrHedge: { prepareCandidates: async () => [], runPrepared: async () => recognized },
  } });
  setHost(host);
  const logs: Array<{ level: string; message: string }> = [];
  host.ctx.logger.exporter({ levels: { default: 4 }, export(record) {
    logs.push({ level: record.type, message: record.args.map(String).join(' ') });
  } });
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlW8AAAAASUVORK5CYII=', 'base64');
  const blob = owner.blobs.storeBlob(db, path.join(storage.locations.activeDir, 'vfs_blobs'), image, 'image/png');
  const file = owner.files.createFileWithDocDataInFolder(db, 'wp202', 'scan.pdf', 100,
    'file', 'application/pdf', null, null, null, null, null, 1);
  const resourceId = file.resourceId!;
  expect(resourceId).not.toBe(file.id);
  owner.files.updatePdfPreviewOnly(db, file.id, JSON.stringify({
    pages: [{ pageIndex: 0, blobHash: blob.hash, width: 1, height: 1, mimeType: 'image/png' }],
    renderDpi: 150, totalPages: 1, renderedAt: 'recorded',
  }));
  owner.files.updateProcessingProgress(db, file.id,
    '{"stage":"ocr_processing","percent":20,"readyModes":["text"]}');
  // A file-id-shaped resource must not be selected by the resource cache writer.
  db.run(`INSERT INTO resources (id, hash, type, storage_mode, data, created_at, updated_at, ocr_text)
    VALUES (?, 'wp202-decoy', 'file', 'inline', 'decoy', 17, 42, 'untouched')`, [file.id]);
  const before = db.get<Row>('SELECT * FROM resources WHERE id = ?', [resourceId])!;
  const decoy = db.get('SELECT * FROM resources WHERE id = ?', [file.id]);
  if (reject) {
    db.exec(`CREATE TEMP TRIGGER reject_recovery_cache BEFORE UPDATE OF ocr_text, updated_at ON resources
      WHEN NEW.id <> '${file.id}'
      BEGIN SELECT RAISE(ABORT, 'cache rejected Ω'); END`);
  }
  let completedRow: Row | undefined;
  let completedProgress: unknown;
  host.ctx.backendEvents.listen('vfs-index-progress', payload => {
    if (typeof payload === 'object' && payload !== null && 'type' in payload && payload.type === 'auto_ocr_completed') {
      completedRow = db.get<Row>('SELECT * FROM resources WHERE id = ?', [resourceId]);
      completedProgress = JSON.parse(String(db.pluck('SELECT processing_progress FROM files WHERE id = ?', [file.id])));
    }
  });
  const lower = String(db.pluck("SELECT datetime('now')"));
  const returned = await host.ctx.vfsIndex.indexing.indexResource(resourceId);
  const upper = String(db.pluck("SELECT datetime('now')"));
  const events = host.eventsNamed('vfs-index-progress');
  process.stdout.write(`WP-202 public RAW ${JSON.stringify({ reject, resourceId, fileId: file.id,
    returned, before, completedRow, completedProgress, events, logs })}\n`);
  expect(returned).toEqual([0, 0]);
  expect(events.at(-1)).toMatchObject({ type: 'auto_ocr_completed', resourceId, fileId: file.id,
    success: true, successCount: 1, failCount: 0, totalPages: 1, textLength: Buffer.byteLength(recognized) });
  expect(completedProgress).toMatchObject({ readyModes: ['text', 'ocr'] });
  expect(db.pluck('SELECT ocr_pages_json FROM files WHERE id = ?', [file.id]))
    .toContain(JSON.stringify(recognized));
  expect(db.get('SELECT * FROM resources WHERE id = ?', [file.id])).toEqual(decoy);
  expect(logs).toContainEqual({ level: 'info', message:
    `[VfsFullIndexingService] Auto-OCR succeeded for ${resourceId} (${Buffer.byteLength(recognized)} chars)` });
  if (reject) {
    expect(completedRow).toEqual(before);
    expect(logs.filter(log => log.level === 'warn' && log.message.startsWith('[VfsIndexing] Failed to cache')))
      .toContainEqual({ level: 'warn', message: `[VfsIndexing] Failed to cache ocr_text for resource ${resourceId}: cache rejected Ω` });
    expect(logs.some(log => log.message.includes('Database error:'))).toBe(false);
  } else {
    expect(completedRow).toEqual({ ...before, ocr_text: recognized, updated_at: completedRow?.updated_at });
    expect(completedRow?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(String(completedRow?.updated_at) >= lower && String(completedRow?.updated_at) <= upper).toBe(true);
    expect(db.pluck('SELECT typeof(updated_at) FROM resources WHERE id = ?', [resourceId])).toBe('text');
    expect(logs.filter(log => log.level === 'warn')).toEqual([]);
  }
});

it('WP-202 cache uses caller transaction, missing resource is a no-op, generic cache keeps milliseconds', async () => {
  const { db, owner } = fresh();
  db.run(`INSERT INTO resources (id, hash, type, storage_mode, data, created_at, updated_at, ocr_text)
    VALUES ('res_tx', 'wp202-tx', 'file', 'inline', 'keep', 17, 42, 'old')`);
  const before = db.get('SELECT * FROM resources WHERE id = ?', ['res_tx']);
  const rollback = new Error('caller rollback');
  await expect(db.withTransaction(async tx => {
    // TEMP objects exist only on this connection, and cannot be observed by a
    // newly opened owner connection. No spy replaces the owner or SQL executor.
    tx.exec(`CREATE TEMP TABLE cache_writes (resource_id TEXT, value TEXT, stamp TEXT, sql_now TEXT);
      CREATE TEMP TRIGGER observe_cache AFTER UPDATE OF ocr_text ON main.resources
      BEGIN INSERT INTO cache_writes VALUES (NEW.id, NEW.ocr_text, NEW.updated_at, datetime('now')); END;`);
    const original = '  原文\r\n Ω \u0000尾  ';
    expect(updateResourceOcrTextRow(tx, 'res_tx', original, owner)).toBeUndefined();
    const written = tx.get<Row>('SELECT * FROM cache_writes')!;
    expect(written).toEqual({ resource_id: 'res_tx', value: original, stamp: written.sql_now, sql_now: written.sql_now });
    expect(tx.pluck('SELECT typeof(updated_at) FROM resources WHERE id = ?', ['res_tx'])).toBe('text');
    expect(tx.get('SELECT * FROM resources WHERE id = ?', ['res_tx']))
      .toEqual({ ...before, ocr_text: original, updated_at: written.sql_now });
    expect(db.get('SELECT * FROM resources WHERE id = ?', ['res_tx'])).toEqual(before);
    const count = tx.pluck('SELECT COUNT(*) FROM resources');
    expect(updateResourceOcrTextRow(tx, 'res_missing', original, owner)).toBeUndefined();
    expect(tx.pluck('SELECT COUNT(*) FROM resources')).toBe(count);
    expect(tx.pluck('SELECT COUNT(*) FROM cache_writes')).toBe(1);
    throw rollback;
  })).rejects.toBe(rollback);
  expect(db.get('SELECT * FROM resources WHERE id = ?', ['res_tx'])).toEqual(before);
  const lower = Date.now();
  saveResourceOcrText(db, 'res_tx', 'generic', false, owner);
  const updatedAt = db.pluck<number>('SELECT updated_at FROM resources WHERE id = ?', ['res_tx'])!;
  expect(updatedAt).toBeGreaterThanOrEqual(lower);
  expect(updatedAt).toBeLessThanOrEqual(Date.now());
  expect(db.pluck('SELECT typeof(updated_at) FROM resources WHERE id = ?', ['res_tx'])).toBe('integer');
});

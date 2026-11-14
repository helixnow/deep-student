import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { format } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVfsHost, type VfsHost } from './harness.ts';

let vfs: VfsHost;
beforeEach(async () => { vfs = await createVfsHost(); }, 120_000);
afterEach(async () => { vi.restoreAllMocks(); await vfs?.dispose(); });

function fixture(legacyVectorColumn: boolean, directoryExists = true) {
  const db = vfs.storage.database('vfs');
  const repos = vfs.host.ctx.vfsRepo;
  const file = repos.files.createFile(db, 'pre-vector', 'cache.pdf', 4, 'document', 'application/pdf');
  const resourceId = file.resourceId!;
  db.run('UPDATE files SET ocr_pages_json=?1 WHERE id=?2', ['["OCR"]', file.id]);
  db.run('UPDATE resources SET ocr_text=?1 WHERE id=?2', ['OCR', resourceId]);
  if (legacyVectorColumn) {
    // Exercise the Rust successful branch separately from its actual missing-column error.
    db.exec('ALTER TABLE resources ADD COLUMN vector_indexed_at INTEGER');
    db.run('UPDATE resources SET vector_indexed_at=123 WHERE id=?1', [resourceId]);
  }
  const unit = repos.embeddingUnits.create(db, { resourceId, unitIndex: 0, imageBlobHash: null,
    imageMimeType: null, textContent: 'text', textSource: 'native' });
  repos.embeddingDims.register(db, 768, 'text');
  repos.embeddingSegments.create(db, { unitId: unit.id, segmentIndex: 0, modality: 'text', embeddingDim: 768,
    lanceRowId: 'pre-vector-row', contentText: 'text', contentHash: null, startPos: null, endPos: null, metadataJson: null });
  repos.embeddingDims.updateCount(db, 768, 'text', 7);
  const lanceDir = join(dirname(vfs.host.ctx.vfsDatabase.blobsDir()), 'lance', 'vfs');
  if (directoryExists) {
    fs.mkdirSync(join(lanceDir, 'nested'), { recursive: true });
    fs.writeFileSync(join(lanceDir, 'first'), 'abc');
    fs.writeFileSync(join(lanceDir, 'nested', 'second'), '中文');
  }
  const snapshot = () => ({
    resourceOcr: db.pluck('SELECT ocr_text FROM resources WHERE id=?1', [resourceId]),
    fileOcr: db.pluck('SELECT ocr_pages_json FROM files WHERE id=?1', [file.id]),
    units: db.pluck('SELECT COUNT(*) FROM vfs_index_units'),
    segments: db.pluck('SELECT COUNT(*) FROM vfs_index_segments'),
    dimensionCount: repos.embeddingDims.getByKey(db, 768, 'text')!.recordCount,
    directoryExists: fs.existsSync(lanceDir),
  });
  return { db, resourceId, lanceDir, snapshot };
}

function observeStages(f: ReturnType<typeof fixture>, removalFailure = false) {
  const events: string[] = [];
  const atRemoval: unknown[] = [];
  const atVectorSql: unknown[] = [];
  const warnings: string[] = [];
  const remove = vfs.host.ctx.files.rm.bind(vfs.host.ctx.files);
  vi.spyOn(vfs.host.ctx.files, 'rm').mockImplementation(async (path, options) => {
    if (String(path) === f.lanceDir) {
      events.push('remove');
      atRemoval.push(f.snapshot()); // Assert outside the owner's best-effort catch.
      if (removalFailure) throw new Error('Lance directory removal denied');
    }
    return remove(path, options);
  });
  const run = f.db.run.bind(f.db);
  vi.spyOn(f.db, 'run').mockImplementation((query, params) => {
    if (query === 'DELETE FROM vfs_index_segments') {
      events.push('vector-sql');
      atVectorSql.push(f.snapshot());
    }
    return run(query, params);
  });
  vfs.host.ctx.logger.exporter({ levels: { default: 4 }, export: message => {
    const text = format(...message.args);
    if (message.type === 'warn' && text.includes('Failed to remove lance dir')) {
      events.push('warn');
      warnings.push(text);
    }
  } });
  return { events, atRemoval, atVectorSql, warnings };
}
const clearedOcrBeforeSql = { resourceOcr: null, fileOcr: null, units: 1, segments: 1, dimensionCount: 7 };
const afterSql = { resourceOcr: null, fileOcr: null, units: 0, segments: 0, dimensionCount: 0 };
const invokeClear = () => vfs.host.invoke('vfs_clear_media_cache', { params: {
  clearPdfPreview: false, clearCompressedImages: false, clearOcrText: true, clearVectorIndex: true,
} });

describe('real vfs_clear_media_cache pre-vector file stage', { timeout: 120_000 }, () => {
  it('clears OCR then removes files before vector SQL and retains the original missing-column failure', async () => {
    const f = fixture(false);
    const seen = observeStages(f);
    await expect(invokeClear()).rejects.toBe('Database error: no such column: vector_indexed_at');
    expect(seen.events).toEqual(['remove', 'vector-sql']);
    expect(seen.atRemoval).toEqual([{ ...clearedOcrBeforeSql, directoryExists: true }]);
    expect(seen.atVectorSql).toEqual([{ ...clearedOcrBeforeSql, directoryExists: false }]);
    expect(f.snapshot()).toEqual({ ...afterSql, directoryExists: false });
  });

  it('counts bytes and the cleared directory only after real removal succeeds', async () => {
    const f = fixture(true);
    const seen = observeStages(f);
    expect(await invokeClear()).toEqual({ pdfPreviewCleared: 0, compressedImagesCleared: 0,
      ocrTextCleared: 1, vectorIndexCleared: 1, totalBytesFreed: 9, filesReset: 2 });
    expect(seen.events).toEqual(['remove', 'vector-sql']);
    expect(seen.atRemoval).toEqual([{ ...clearedOcrBeforeSql, directoryExists: true }]);
    expect(seen.atVectorSql).toEqual([{ ...clearedOcrBeforeSql, directoryExists: false }]);
    expect(f.snapshot()).toEqual({ ...afterSql, directoryExists: false });
    expect(f.db.pluck('SELECT vector_indexed_at FROM resources WHERE id=?1', [f.resourceId])).toBeNull();
  });

  it('warns after file removal failure, continues vector SQL and does not claim freed bytes', async () => {
    const f = fixture(true);
    const seen = observeStages(f, true);
    expect(await invokeClear()).toEqual({ pdfPreviewCleared: 0, compressedImagesCleared: 0,
      ocrTextCleared: 1, vectorIndexCleared: 0, totalBytesFreed: 0, filesReset: 2 });
    expect(seen.events).toEqual(['remove', 'warn', 'vector-sql']);
    expect(seen.warnings).toHaveLength(1);
    expect(seen.warnings[0]).toContain('Lance directory removal denied');
    expect(seen.atRemoval).toEqual([{ ...clearedOcrBeforeSql, directoryExists: true }]);
    expect(seen.atVectorSql).toEqual([{ ...clearedOcrBeforeSql, directoryExists: true }]);
    expect(f.snapshot()).toEqual({ ...afterSql, directoryExists: true });
    expect(fs.readFileSync(join(f.lanceDir, 'first'), 'utf8')).toBe('abc');
  });

  it('continues vector SQL without file counts when the Lance directory is absent', async () => {
    const f = fixture(true, false);
    const seen = observeStages(f);
    expect(await invokeClear()).toEqual({ pdfPreviewCleared: 0, compressedImagesCleared: 0,
      ocrTextCleared: 1, vectorIndexCleared: 0, totalBytesFreed: 0, filesReset: 2 });
    expect(seen.events).toEqual(['vector-sql']);
    expect(seen.atRemoval).toEqual([]);
    expect(f.snapshot()).toEqual({ ...afterSql, directoryExists: false });
  });
});

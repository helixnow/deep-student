import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVfsHost, type VfsHost } from './harness.ts';
import { parseOcrPagesForDisplay } from '../repository/media-cache.ts';
import type { ClearMediaCacheParams, ResourceOcrInfo } from '../../../../contracts/ipc/generated/L13-vfs-api.ts';

let vfs: VfsHost;
beforeEach(async () => { vfs = await createVfsHost(); }, 120_000);
afterEach(async () => { await vfs?.dispose(); });
const db = () => vfs.storage.database('vfs');
const repos = () => vfs.host.ctx.vfsRepo;
const invoke = <T = unknown>(name: string, args: Record<string, unknown> = {}) => vfs.host.invoke(name, args) as Promise<T>;
const clear = (flags: Partial<ClearMediaCacheParams>) => invoke('vfs_clear_media_cache', {
  params: { clearPdfPreview: false, clearCompressedImages: false, clearOcrText: false, clearVectorIndex: false, ...flags },
});
function seed() {
  const file = repos().files.createFile(db(), 'ocr-cache', 'cache.pdf', 100, 'document', 'application/pdf');
  const { resourceId } = repos().resources.createOrReuse(db(), 'file', '{}', file.id, 'files', null);
  db().run('UPDATE files SET resource_id=?1,extracted_text=?2,ocr_pages_json=?3 WHERE id=?4', [resourceId, '提取', '["中文",null,"[OCR_FAILED]"]', file.id]);
  db().run("UPDATE resources SET ocr_text='识别',index_state='indexed' WHERE id=?1", [resourceId]);
  return { id: file.id, resourceId };
}

describe('OCR and media cache command parity', { timeout: 120_000 }, () => {
  it('reports UTF-8 byte lengths, page failures, and OCR source precedence', async () => {
    const file = seed();
    expect(await invoke('vfs_get_resource_ocr_info', { resourceId: file.resourceId })).toEqual({
      resourceId: file.resourceId, resourceType: 'file', hasOcr: true, ocrText: '识别', ocrTextLength: 6,
      extractedText: '提取', extractedTextLength: 6, activeSource: 'ocr',
      ocrPages: [{ pageIndex: 0, text: '中文', charCount: 6, isFailed: false },
        { pageIndex: 1, text: '', charCount: 0, isFailed: true }, { pageIndex: 2, text: '', charCount: 0, isFailed: true }],
    });
    await expect(invoke('vfs_get_resource_ocr_info', { resourceId: 'missing' })).rejects.toBe('Resource not found: Query returned no rows');
  });
  it('clears OCR through the source-id fallback and requeues indexing', async () => {
    const file = seed();
    db().run('UPDATE files SET resource_id=NULL WHERE id=?1', [file.id]);
    expect(await invoke('vfs_get_resource_ocr_info', { resourceId: file.resourceId })).toMatchObject({ extractedText: '提取' });
    expect(await invoke('vfs_clear_resource_ocr', { resourceId: file.resourceId })).toBe(true);
    expect(await invoke<ResourceOcrInfo>('vfs_get_resource_ocr_info', { resourceId: file.resourceId })).toMatchObject({
      hasOcr: false, ocrText: null, ocrPages: null, activeSource: 'extracted',
    });
    expect(repos().indexStates.getIndexState(db(), file.resourceId)?.state).toBe('pending');
  });
  it('keeps display parsing separate from the normalized OCR parser', () => {
    expect(parseOcrPagesForDisplay('[]')).toEqual([]);
    expect(parseOcrPagesForDisplay('{"pages":[{"pageIndex":3,"blocks":[{"text":"中文"},{"text":""}]}]}'))
      .toEqual([{ pageIndex: 3, text: '中文\n', charCount: 7, isFailed: false }]);
    expect(parseOcrPagesForDisplay('{"pages":[{"page_index":3,"blocks":[]}]}')).toBeNull();
    expect(parseOcrPagesForDisplay('invalid')).toBeNull();
    expect(parseOcrPagesForDisplay('["__OCR_FAILED__"]')?.[0]?.isFailed).toBe(false);
  });
  it('lists units in order and measures bytes instead of JS character length', async () => {
    const file = seed();
    for (const index of [2, 0]) repos().embeddingUnits.create(db(), { resourceId: file.resourceId,
      unitIndex: index, imageBlobHash: null, imageMimeType: null, textContent: '中文', textSource: 'ocr' });
    const chunks = await invoke<Array<{ unitIndex: number; charCount: number; textContent: string }>>('vfs_get_resource_text_chunks', { resourceId: file.resourceId });
    expect(chunks.map(c => c.unitIndex)).toEqual([0, 2]);
    expect(chunks.map(c => [c.textContent, c.charCount])).toEqual([['中文', 6], ['中文', 6]]);
  });
  it('counts legacy snake-case previews and clears both spellings, preserving unrelated ready modes', async () => {
    const file = seed();
    const blobsDir = vfs.host.ctx.vfsDatabase.blobsDir();
    const a = repos().blobs.storeBlob(db(), blobsDir, Buffer.from('original'), 'image/png', 'png');
    const b = repos().blobs.storeBlob(db(), blobsDir, Buffer.from('compressed'), 'image/jpeg', 'jpg');
    db().run('UPDATE files SET preview_json=?1,processing_progress=?2,processing_status=?3 WHERE id=?4', [
      JSON.stringify({ pages: [{ blob_hash: a.hash, compressedBlobHash: b.hash }, { blobHash: a.hash }] }),
      JSON.stringify({ readyModes: ['text', 'image', 'ocr'], stageProgress: 100 }), 'completed', file.id]);
    expect(await invoke('vfs_get_media_cache_stats')).toMatchObject({ pdfPreviewCount: 1, pdfPreviewSize: 8, ocrTextCount: 1 });
    expect(await clear({ clearPdfPreview: true, clearOcrText: true })).toEqual({ pdfPreviewCleared: 3,
      compressedImagesCleared: 0, ocrTextCleared: 1, vectorIndexCleared: 0, totalBytesFreed: 26, filesReset: 2 });
    const row = db().one<{ processing_progress: string; processing_status: string; preview_json: null }>('SELECT processing_progress,processing_status,preview_json FROM files WHERE id=?1', [file.id]);
    expect(JSON.parse(row.processing_progress)).toEqual({ readyModes: ['text'], stageProgress: 100 });
    expect(row.processing_status).toBe('pending');
    expect(row.preview_json).toBeNull();
  });
  it('does not decrement a compressed hash equal to the original or remove image readiness', async () => {
    const file = seed();
    const blob = repos().blobs.storeBlob(db(), vfs.host.ctx.vfsDatabase.blobsDir(), Buffer.from('same'), 'image/png', 'png');
    db().run('UPDATE files SET blob_hash=?1,compressed_blob_hash=?1,processing_progress=?2 WHERE id=?3',
      [blob.hash, '{"ready_modes":["text","image","ocr"]}', file.id]);
    expect(await clear({ clearCompressedImages: true })).toMatchObject({ compressedImagesCleared: 1, filesReset: 1, totalBytesFreed: 0 });
    expect(repos().blobs.getBlob(db(), blob.hash)?.refCount).toBe(blob.refCount);
    expect(JSON.parse(db().pluck<string>('SELECT processing_progress FROM files WHERE id=?1', [file.id])!)).toEqual({ ready_modes: ['text', 'image', 'ocr'] });
  });
});

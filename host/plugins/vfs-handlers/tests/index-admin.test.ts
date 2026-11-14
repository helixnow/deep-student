import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVfsHost, type VfsHost } from './harness.ts';
import type { VfsIndexService } from '../../vfs-index/api.ts';
import { batchIndex, deleteResourceIndex, getStatus, syncResourceUnits, VECTOR_UNAVAILABLE, type IndexAdminDeps } from '../src/index-admin.ts';

let vfs: VfsHost;
beforeEach(async () => { vfs = await createVfsHost(); }, 120_000);
afterEach(async () => { await vfs?.dispose(); });
const db = () => vfs.storage.database('vfs');
const repos = () => vfs.host.ctx.vfsRepo;
const deps = (): IndexAdminDeps => ({ conn: db, repos: repos(), index: vfs.host.ctx.vfsIndex, vectorAvailable: true, log: vfs.host.ctx.logger, maintenance: vfs.host.ctx.vfsIndexMaintenance });
const resetUnitIndex = (_db: unknown, _repos: unknown, id: string, mode: string) =>
  vfs.host.ctx.vfsIndexMaintenance.resetUnitIndex(id, mode);
function seed(): string {
  db().run(`INSERT INTO resources (id,hash,type,storage_mode,data,ref_count,created_at,updated_at,index_state,mm_index_state)
    VALUES ('res_unit','hash_unit','note','inline','content',0,1,1,'indexed','indexed')`);
  db().run(`INSERT INTO vfs_index_units (id,resource_id,unit_index,text_content,text_required,mm_required,image_blob_hash,text_state,mm_state,created_at,updated_at)
    VALUES ('unit_1','res_unit',0,'text',1,1,'blob1','indexed','indexed',1,1)`);
  return 'unit_1';
}
function states(): unknown[] {
  const u = repos().embeddingUnits.getById(db(), 'unit_1')!;
  const r = db().one<{ index_state: string; mm_index_state: string }>('SELECT index_state,mm_index_state FROM resources WHERE id=?1', ['res_unit']);
  return [u.textState, u.mmState, r.index_state, r.mm_index_state];
}

describe('index_service.rs::tests', { timeout: 120_000 }, () => {
  it('sync_resource_units_uses_single_pool_connection', async () => {
    seed();
    const conn = db();
    const databaseLookup = vi.spyOn(vfs.storage, 'database');
    databaseLookup.mockImplementation(() => { throw new Error('no additional pool connection available'); });
    try {
      const units = await vfs.host.invoke('vfs_sync_resource_units', {
        resourceId: 'res_unit', resourceType: 'note', data: 'updated note content',
      });
      expect(databaseLookup).not.toHaveBeenCalled();
      expect(units).toEqual([expect.objectContaining({ resourceId: 'res_unit', hasText: true, textState: 'pending' })]);
      expect(conn.pluck('SELECT text_content FROM vfs_index_units WHERE resource_id=?1', ['res_unit'])).toBe('updated note content');
      expect(conn.pluck('SELECT index_state FROM resources WHERE id=?1', ['res_unit'])).toBe('pending');
    } finally { databaseLookup.mockRestore(); }
  });
  it('reset_unit_index_text_mode_updates_unit_and_resource_atomically', () => {
    resetUnitIndex(db(), repos(), seed(), 'text');
    expect(states()).toEqual(['pending', 'indexed', 'pending', 'indexed']);
  });
  it('reset_unit_index_mm_mode_updates_unit_and_resource_atomically', () => {
    resetUnitIndex(db(), repos(), seed(), 'mm');
    expect(states()).toEqual(['indexed', 'pending', 'indexed', 'pending']);
  });
  it('reset_unit_index_both_mode_updates_all_four_states', () => {
    resetUnitIndex(db(), repos(), seed(), 'both');
    expect(states()).toEqual(['pending', 'pending', 'pending', 'pending']);
  });
  it('reset_unit_index_unknown_mode_writes_nothing', () => {
    const id = seed();
    expect(() => resetUnitIndex(db(), repos(), id, 'bogus')).toThrow("unsupported index reset mode 'bogus'; expected text, mm, or both");
    expect(states()).toEqual(['indexed', 'indexed', 'indexed', 'indexed']);
  });
});

describe('index administration commands', { timeout: 120_000 }, () => {
  it('rolls back unit changes when the resource scheduling write fails', () => {
    const id = seed();
    db().exec(`CREATE TRIGGER reject_reset BEFORE UPDATE OF index_state ON resources
      BEGIN SELECT RAISE(ABORT, 'injected resource failure'); END;`);
    expect(() => resetUnitIndex(db(), repos(), id, 'both')).toThrow('injected resource failure');
    expect(states()).toEqual(['indexed', 'indexed', 'indexed', 'indexed']);
  });
  it('keeps unrequired modalities disabled and resets retry backoff for required ones', () => {
    seed();
    db().run('UPDATE vfs_index_units SET text_required=0,image_blob_hash=NULL WHERE id=?1', ['unit_1']);
    resetUnitIndex(db(), repos(), 'unit_1', 'both');
    expect(states()).toEqual(['disabled', 'disabled', 'indexed', 'indexed']);
    db().run('UPDATE vfs_index_units SET text_required=1 WHERE id=?1', ['unit_1']);
    db().run('UPDATE resources SET index_retry_count=4,index_next_retry_at=999999 WHERE id=?1', ['res_unit']);
    resetUnitIndex(db(), repos(), 'unit_1', 'text');
    expect(db().one('SELECT index_retry_count,index_next_retry_at FROM resources WHERE id=?1', ['res_unit']))
      .toEqual({ index_retry_count: 0, index_next_retry_at: 0 });
  });
  it('serializes units, summary and dimensions using the wire fields', async () => {
    seed();
    const units = await vfs.host.invoke('vfs_get_resource_units', { resourceId: 'res_unit' });
    expect(units).toEqual([expect.objectContaining({ unitId: 'unit_1', hasImage: true, hasText: true, textState: 'indexed', mmState: 'indexed' })]);
    expect(await vfs.host.invoke('vfs_unified_index_status', {})).toEqual({ totalUnits: 1,
      textStats: { pending: 0, indexing: 0, indexed: 1, failed: 0, disabled: 0 },
      mmStats: { pending: 0, indexing: 0, indexed: 1, failed: 0, disabled: 0 }, dimensions: [] });
    repos().embeddingDims.register(db(), 768, 'text');
    expect(await vfs.host.invoke('vfs_list_embedding_dims', {})).toEqual([{ dimension: 768, modality: 'text', lanceTableName: 'vfs_emb_text_768', recordCount: 0 }]);
  });
  it('vfs_unified_index_status delegates to the L12 get_status_summary owner and maps its errors', async () => {
    seed();
    const summary = vi.spyOn(vfs.host.ctx.vfsIndex as Required<VfsIndexService>, 'getStatusSummary');
    expect(await vfs.host.invoke('vfs_unified_index_status', {})).toEqual(summary.mock.results[0]!.value);
    expect(summary).toHaveBeenCalledTimes(1);
    summary.mockImplementationOnce(() => { throw new Error('no such table: vfs_index_units'); });
    await expect(vfs.host.invoke('vfs_unified_index_status', {})).rejects.toBe('no such table: vfs_index_units');
    const { getStatusSummary: _omitted, ...withoutSummary } = vfs.host.ctx.vfsIndex;
    expect(() => getStatus({ ...deps(), index: withoutSummary })).toThrow('vfsIndex.getStatusSummary is not available');
  });
  it('rejects indexing before claiming resources when the vector provider is absent', async () => {
    seed();
    await expect(vfs.host.invoke('vfs_reindex_unit', { unitId: 'unit_1', mode: 'text' })).rejects.toBe(VECTOR_UNAVAILABLE);
    await expect(vfs.host.invoke('vfs_unified_batch_index', { mode: 'both' })).rejects.toBe(VECTOR_UNAVAILABLE);
    expect(states()).toEqual(['indexed', 'indexed', 'indexed', 'indexed']);
  });
  it('clamps text/mm batch sizes and sums both modality results', async () => {
    const base = deps();
    const calls: unknown[] = [];
    base.index = { ...base.index, indexing: { ...base.index.indexing,
      getIndexingConfig: () => vfs.host.ctx.vfsIndex.indexing.getIndexingConfig(),
      async processPendingBatch(limit) { calls.push(['text', limit]); return [2, 1]; } } };
    base.multimodalBatch = { async processPendingBatch(limit) { calls.push(['mm', limit]); return [3, 4]; } };
    expect(await batchIndex(base, 'both', 500)).toEqual({ successCount: 5, failCount: 5, total: 10 });
    expect(calls).toEqual([['text', 100], ['mm', 100]]);
    expect(await batchIndex(base, 'mm', -1)).toEqual({ successCount: 3, failCount: 4, total: 7 });
    expect(calls.at(-1)).toEqual(['mm', 1]);
    await expect(batchIndex(base, 'bad', 1)).rejects.toThrow();
  });
  it('maps the pending unit-builder interface to wire statuses', () => {
    seed();
    const base = deps();
    const calls: unknown[] = [];
    base.unitBuilder = { syncResourceUnits(input) { calls.push(input); return [repos().embeddingUnits.getById(db(), 'unit_1')!]; } };
    const input = { resourceId: 'res_unit', resourceType: 'note', data: 'new text' };
    expect(syncResourceUnits(base, input)).toEqual([expect.objectContaining({ unitId: 'unit_1', resourceId: 'res_unit', hasText: true })]);
    expect(calls).toEqual([input]);
  });
  it('deletes SQLite artifacts, queues orphan rows and reports independent Lance failures', async () => {
    seed();
    repos().embeddingDims.register(db(), 768, 'text');
    repos().embeddingSegments.create(db(), { unitId: 'unit_1', segmentIndex: 0, modality: 'text', embeddingDim: 768,
      lanceRowId: 'row_1', contentText: 'text', contentHash: null, startPos: null, endPos: null, metadataJson: null });
    const base = deps();
    const calls: string[] = [];
    const warn = vi.spyOn(vfs.host.ctx.logger, 'warn');
    base.index = { ...base.index, lance: { ...base.index.lance, async deleteByResource(modality) {
      calls.push(modality); if (modality === 'text') throw new Error('Lance offline'); return 0;
    } } };
    expect(await deleteResourceIndex(base, 'res_unit')).toEqual({ sqliteOk: true, lanceTextOk: false, lanceMmOk: true,
      warnings: ['Failed to delete text vectors: Lance offline'], retryable: true });
    expect(calls).toEqual(['text', 'multimodal']);
    expect(warn).toHaveBeenCalledWith('[VFS::index_handlers] Failed to delete text vectors for resource %s: %s', 'res_unit', 'Lance offline');
    warn.mockRestore();
    expect(repos().embeddingUnits.getByResource(db(), 'res_unit')).toEqual([]);
    expect(repos().embeddingSegments.countPendingLanceOrphans(db())).toBe(1);
    expect(repos().embeddingDims.getByKey(db(), 768, 'text')!.recordCount).toBe(0);
  });
});

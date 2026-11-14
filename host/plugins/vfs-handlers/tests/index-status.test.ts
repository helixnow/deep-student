import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVfsHost, type VfsHost } from './harness.ts';
import type { IndexDiagnosticInfo, dstu_vfs__vfs__handlers__IndexStatusSummary as Summary } from '../../../../contracts/ipc/generated/L13-vfs-api.ts';

let vfs: VfsHost;
beforeEach(async () => { vfs = await createVfsHost(); }, 120_000);
afterEach(async () => { await vfs?.dispose(); });
const db = () => vfs.storage.database('vfs');
const invoke = <T = unknown>(name: string, args: Record<string, unknown> = {}) => vfs.host.invoke(name, args) as Promise<T>;
const note = (title: string) => invoke<{ id: string; resourceId: string }>('vfs_create_note', { params: { title, content: '中文 text' } });

describe('resource index summaries and diagnostics', { timeout: 120_000 }, () => {
  it('keeps aggregate counts independent of state filter, pagination and orphan resources', async () => {
    const a = await note('indexed'); const b = await note('pending');
    db().run("UPDATE resources SET index_state='indexed',index_hash='old',updated_at=123 WHERE id=?1", [a.resourceId]);
    vfs.host.ctx.vfsRepo.resources.createOrReuse(db(), 'note', 'orphan', null, null, null);
    const result = await invoke<Summary>('vfs_get_all_index_status', { stateFilter: 'indexed', limit: 1 });
    expect(result).toMatchObject({ totalResources: 2, indexedCount: 1, pendingCount: 1, staleCount: 1 });
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]).toMatchObject({ resourceId: a.resourceId, name: 'indexed', textIndexState: 'indexed', isStale: true,
      textChunkCount: 0, textIndexSource: 'sqlite', mmIndexState: 'disabled', updatedAt: 123 });
    expect((await invoke<Summary>('vfs_get_all_index_status', { stateFilter: 'pending' })).resources.map(r => r.resourceId)).toEqual([b.resourceId]);
  });
  it('uses resource ids for the legacy folder filter and SQL UTC timestamp fallback', async () => {
    const a = await note('filtered');
    const folder = { id: 'fld_filter' };
    db().run("INSERT INTO folders (id,title,created_at,updated_at) VALUES ('fld_filter','Folder',1,1)");
    db().run(`INSERT INTO folder_items (id,folder_id,item_type,item_id,sort_order,created_at) VALUES ('fi_filter',?1,'note',?2,0,1)`, [folder.id, a.resourceId]);
    db().run("UPDATE resources SET updated_at='2026-01-02 03:04:05' WHERE id=?1", [a.resourceId]);
    const result = await invoke<Summary>('vfs_get_all_index_status', { folderId: folder.id, resourceType: 'note' });
    expect(result.totalResources).toBe(1);
    expect(result.resources[0]!.updatedAt).toBe(Date.parse('2026-01-02T03:04:05Z'));
  });
  it('diagnostics expose mismatches and keep resourceId compatibility argument unfiltered', async () => {
    const a = await note('a'); await note('b');
    db().run("UPDATE resources SET index_state='indexed' WHERE id=?1", [a.resourceId]);
    const result = await invoke<IndexDiagnosticInfo>('vfs_debug_index_status', { resourceId: a.resourceId });
    expect(result.totalResources).toBe(2);
    expect(result.allResources).toHaveLength(2);
    expect(result.stateCounts).toEqual({ pending: 1, indexed: 1, indexing: 0, failed: 0, disabled: 0, nullState: 0 });
    expect(result.consistencyChecks).toContainEqual({ checkName: 'resources_indexed_without_units', passed: false, details: '1 个资源状态为 indexed 但无 units 记录' });
    expect(result.unitsStats.totalCount).toBe(0);
    expect(result.segmentsStats.avgSegmentsPerUnit).toBe(0);
    expect(result.architectureVersion).toBe('unified_index_v1');
  });
});

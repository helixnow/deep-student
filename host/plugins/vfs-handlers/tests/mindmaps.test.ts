import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVfsHost, type VfsHost } from './harness.ts';
import type { MindmapService } from '../src/mindmaps.ts';

const map = { id: 'mm_1', resourceId: 'res_1', title: 'Map', isFavorite: false, defaultView: 'mindmap',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', contentUpdatedAt: '2026-01-01T00:00:00Z' };
const version = { versionId: 'mv_1', mindmapId: 'mm_1', resourceId: 'res_old', title: 'Old', createdAt: map.createdAt };
function serviceDouble() {
  return {
    createMindmapInFolder: vi.fn<MindmapService['createMindmapInFolder']>(() => map),
    getMindmap: vi.fn<MindmapService['getMindmap']>(() => map),
    getMindmapContent: vi.fn<MindmapService['getMindmapContent']>(() => '{"root":{}}'),
    getVersionsPaged: vi.fn<MindmapService['getVersionsPaged']>(() => [version]),
    restoreVersion: vi.fn<MindmapService['restoreVersion']>(() => map),
    getVersionContent: vi.fn<MindmapService['getVersionContent']>(() => 'old content'),
    getVersion: vi.fn<MindmapService['getVersion']>(() => version),
    updateMindmap: vi.fn<MindmapService['updateMindmap']>(() => map),
    deleteMindmap: vi.fn<MindmapService['deleteMindmap']>(),
    listMindmaps: vi.fn<MindmapService['listMindmaps']>(() => [map]),
    setFavorite: vi.fn<MindmapService['setFavorite']>(),
  } satisfies MindmapService;
}
let vfs: VfsHost;
let service: ReturnType<typeof serviceDouble>;
beforeEach(async () => {
  service = serviceDouble();
  vfs = await createVfsHost();
  const repo = vfs.host.ctx.vfsRepo.mindmaps;
  vi.spyOn(repo, 'createMindmapInFolder').mockImplementation((_db, params, folder) => service.createMindmapInFolder(params as Parameters<MindmapService['createMindmapInFolder']>[0], folder));
  vi.spyOn(repo, 'getMindmap').mockImplementation((_db, id) => service.getMindmap(id));
  vi.spyOn(repo, 'getMindmapContent').mockImplementation((_db, id) => service.getMindmapContent(id));
  vi.spyOn(repo, 'getVersionsPaged').mockImplementation((_db, id, limit) => service.getVersionsPaged(id, limit));
  vi.spyOn(repo, 'restoreVersion').mockImplementation((_db, id) => service.restoreVersion(id));
  vi.spyOn(repo, 'getVersionContent').mockImplementation((_db, id) => service.getVersionContent(id));
  vi.spyOn(repo, 'getVersion').mockImplementation((_db, id) => service.getVersion(id));
  vi.spyOn(repo, 'updateMindmap').mockImplementation((_db, id, params) => service.updateMindmap(id, params as Parameters<MindmapService['updateMindmap']>[1]));
  vi.spyOn(repo, 'deleteMindmap').mockImplementation((_db, id) => service.deleteMindmap(id));
  vi.spyOn(repo, 'listMindmaps').mockImplementation(() => service.listMindmaps());
  vi.spyOn(repo, 'setFavorite').mockImplementation((_db, id, favorite) => service.setFavorite(id, favorite));
}, 120_000);
afterEach(async () => { await vfs?.dispose(); });
const invoke = (name: string, args: Record<string, unknown> = {}) => vfs.host.invoke(name, args);

describe('mindmap command layer with L11 repository double', { timeout: 120_000 }, () => {
  it('supplies Rust creation defaults and forwards the folder separately', async () => {
    expect(await invoke('vfs_create_mindmap', { params: { title: 'Map', folderId: 'fld_1' } })).toEqual(map);
    expect(service.createMindmapInFolder).toHaveBeenCalledWith({ title: 'Map', description: null,
      content: '{"version":"1.0","root":{"id":"root","text":"根节点","children":[]}}', defaultView: 'mindmap', theme: null }, 'fld_1');
  });
  it('validates ids before calling repositories', async () => {
    for (const name of ['vfs_get_mindmap', 'vfs_get_mindmap_content', 'vfs_delete_mindmap', 'vfs_get_mindmap_versions']) {
      await expect(invoke(name, { mindmapId: 'bad' })).rejects.toBe("Invalid argument 'mindmap_id': Invalid mindmap ID format: bad");
    }
    for (const name of ['vfs_restore_mindmap_version', 'vfs_get_mindmap_version_content', 'vfs_get_mindmap_version']) {
      await expect(invoke(name, { versionId: 'bad' })).rejects.toBe("Invalid argument 'version_id': Invalid version ID format: bad");
    }
    expect(service.getMindmap).not.toHaveBeenCalled();
    expect(service.restoreVersion).not.toHaveBeenCalled();
  });
  it('clamps version pagination and delegates restore/version reads', async () => {
    for (const limit of [undefined, 0, 999]) await invoke('vfs_get_mindmap_versions', { mindmapId: 'mm_1', ...(limit === undefined ? {} : { limit }) });
    expect(service.getVersionsPaged.mock.calls).toEqual([['mm_1', 100], ['mm_1', 1], ['mm_1', 500]]);
    expect(await invoke('vfs_restore_mindmap_version', { versionId: 'mv_1' })).toEqual(map);
    expect(await invoke('vfs_get_mindmap_version_content', { versionId: 'mv_1' })).toBe('old content');
    expect(await invoke('vfs_get_mindmap_version', { versionId: 'mv_1' })).toEqual(version);
  });
  it('restricts snapshot source to manual/auto and keeps optimistic concurrency fields', async () => {
    for (const versionSource of [undefined, 'auto', 'chat_tool']) await invoke('vfs_update_mindmap', {
      mindmapId: 'mm_1', params: { expectedUpdatedAt: map.updatedAt, content: '{}', ...(versionSource === undefined ? {} : { versionSource }) },
    });
    expect(service.updateMindmap.mock.calls.map(([, params]) => params.versionSource)).toEqual(['manual', 'auto', 'manual']);
    expect(service.updateMindmap.mock.calls[0]![1]).toMatchObject({ content: '{}', expectedUpdatedAt: map.updatedAt });
  });
  it('forwards reads, deletion and favorite updates; preserves repository errors', async () => {
    expect(await invoke('vfs_get_mindmap', { mindmapId: 'mm_1' })).toEqual(map);
    expect(await invoke('vfs_get_mindmap_content', { mindmapId: 'mm_1' })).toBe('{"root":{}}');
    expect(await invoke('vfs_list_mindmaps')).toEqual([map]);
    expect(await invoke('vfs_set_mindmap_favorite', { mindmapId: 'mm_1', isFavorite: true })).toBeNull();
    expect(service.setFavorite).toHaveBeenCalledWith('mm_1', true);
    expect(await invoke('vfs_delete_mindmap', { mindmapId: 'mm_1' })).toBeNull();
    expect(service.deleteMindmap).toHaveBeenCalledWith('mm_1');
    service.getMindmap.mockImplementationOnce(() => { throw new Error('repository conflict'); });
    await expect(invoke('vfs_get_mindmap', { mindmapId: 'mm_1' })).rejects.toBe('repository conflict');
  });
});

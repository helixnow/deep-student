import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VfsMindMap, VfsMindMapVersion } from '../../../../contracts/ipc/generated/L13-vfs-api.ts';
import { createVfsHost, type VfsHost } from './harness.ts';

let vfs: VfsHost;
beforeEach(async () => { vfs = await createVfsHost(); }, 120_000);
afterEach(async () => { await vfs?.dispose(); });
const invoke = <T = unknown>(name: string, args: Record<string, unknown> = {}) => vfs.host.invoke(name, args) as Promise<T>;

describe('handlers.rs commands wired to real L11 repositories', { timeout: 120_000 }, () => {
  it('persists mindmaps, versions, restore backups, favorites and soft deletion', async () => {
    const db = vfs.storage.database('vfs');
    const folder = { id: 'fld_maps', title: 'Maps', isExpanded: true, isFavorite: false,
      sortOrder: 0, createdAt: Date.now(), updatedAt: Date.now() };
    vfs.host.ctx.vfsRepo.folders.createFolder(db, folder);
    const map = await invoke<VfsMindMap>('vfs_create_mindmap', { params: { title: 'Map', folderId: folder.id } });
    expect(map.id).toMatch(/^mm_/);
    expect(map.defaultView).toBe('mindmap');
    expect(await invoke('vfs_get_mindmap', { mindmapId: map.id })).toEqual(map);
    const original = await invoke<string>('vfs_get_mindmap_content', { mindmapId: map.id });
    expect(JSON.parse(original).root.text).toBe('根节点');
    expect(vfs.host.ctx.vfsRepo.folders.listItemsByFolder(db, folder.id).map(item => item.itemId)).toContain(map.id);
    const shared = await invoke<VfsMindMap>('vfs_create_mindmap', { params: { title: 'Shared', content: original } });
    expect(shared.resourceId).toBe(map.resourceId);
    const changed = JSON.stringify({ ...JSON.parse(original), root: { id: 'root', text: 'Changed', children: [] } });
    const updated = await invoke<VfsMindMap>('vfs_update_mindmap', { mindmapId: map.id,
      params: { content: changed, expectedUpdatedAt: map.updatedAt, versionSource: 'auto' } });
    expect(updated.resourceId).not.toBe(shared.resourceId);
    expect(await invoke('vfs_get_mindmap_content', { mindmapId: shared.id })).toBe(original);
    expect(await invoke('vfs_get_mindmap_content', { mindmapId: map.id })).toBe(changed);
    const versions = await invoke<VfsMindMapVersion[]>('vfs_get_mindmap_versions', { mindmapId: map.id });
    expect(versions.length).toBeGreaterThan(0);
    const previous = versions.find(version => version.source === 'auto')!;
    expect(previous).toBeDefined();
    expect(await invoke('vfs_get_mindmap_version', { versionId: previous.versionId })).toEqual(previous);
    expect(await invoke('vfs_get_mindmap_version_content', { versionId: previous.versionId })).toBe(original);
    await expect(invoke('vfs_update_mindmap', { mindmapId: map.id,
      params: { content: original, expectedUpdatedAt: '2000-01-01T00:00:00Z' } })).rejects.toEqual(expect.any(String));
    expect(await invoke('vfs_get_mindmap_content', { mindmapId: map.id })).toBe(changed);
    expect(await invoke('vfs_restore_mindmap_version', { versionId: previous.versionId })).toMatchObject({ id: map.id });
    expect(await invoke('vfs_get_mindmap_content', { mindmapId: map.id })).toBe(original);
    const restoredVersions = await invoke<VfsMindMapVersion[]>('vfs_get_mindmap_versions', { mindmapId: map.id });
    const backup = restoredVersions.find(version => version.source === 'restore_backup')!;
    expect(backup).toBeDefined();
    // Rust :1975 deduplicates the backup against the current resource, then
    // :2000 overwrites that same resource because only one mindmap uses it.
    expect(backup.resourceId).toBe(updated.resourceId);
    expect(await invoke('vfs_get_mindmap_version_content', { versionId: backup.versionId })).toBe(original);
    await invoke('vfs_delete_mindmap', { mindmapId: shared.id });
    await invoke('vfs_set_mindmap_favorite', { mindmapId: map.id, isFavorite: true });
    expect(await invoke('vfs_list_mindmaps')).toEqual([expect.objectContaining({ id: updated.id, isFavorite: true })]);
    await invoke('vfs_delete_mindmap', { mindmapId: map.id });
    expect(await invoke('vfs_get_mindmap', { mindmapId: map.id })).toBeNull();
    expect(await invoke('vfs_list_mindmaps')).toEqual([]);
  });

  it('retains Rust single-map snapshot aliasing when updating a deduplicated resource in place', async () => {
    // mindmap_repo.rs:1557 deduplicates the snapshot by hash, while :670 counts
    // only mindmaps (not versions) before choosing the in-place resource update.
    const map = await invoke<VfsMindMap>('vfs_create_mindmap', { params: { title: 'Single' } });
    const original = await invoke<string>('vfs_get_mindmap_content', { mindmapId: map.id });
    const changed = JSON.stringify({ ...JSON.parse(original), root: { id: 'root', text: 'Changed', children: [] } });
    await invoke('vfs_update_mindmap', { mindmapId: map.id, params: { content: changed } });
    const versions = await invoke<VfsMindMapVersion[]>('vfs_get_mindmap_versions', { mindmapId: map.id });
    expect(versions).toHaveLength(1);
    expect(versions[0]!.resourceId).toBe(map.resourceId);
    expect(await invoke('vfs_get_mindmap_version_content', { versionId: versions[0]!.versionId })).toBe(changed);
  });

  it('reads attachment metadata and bounded content through resource aliases and soft deletes', async () => {
    const db = vfs.storage.database('vfs');
    const repos = vfs.host.ctx.vfsRepo;
    const uploaded = await repos.attachments.uploadBytesWithConn(db, vfs.host.ctx.vfsDatabase.blobsDir(),
      { name: 'sample.txt', mimeType: 'text/plain', base64Content: '' }, Buffer.from('hello'));
    const id = uploaded.sourceId;
    expect(await invoke('vfs_get_attachment', { attachmentId: id })).toEqual(uploaded.attachment);
    // Rust get_content_bounded uses the conservative inline-base64 upper bound (8 * 3 / 4).
    const args = { attachmentId: uploaded.attachment.resourceId, maxBytes: 6 };
    expect(await invoke('vfs_get_attachment_content', args)).toEqual({ content: 'aGVsbG8=', found: true });
    expect(await invoke('vfs_get_attachment_content', { ...args, maxBytes: 5 })).toEqual({
      content: null, found: false, error: "Invalid argument 'max_bytes': attachment content exceeds preview limit: 6 > 5 bytes",
    });
    expect(await invoke('vfs_get_attachment_content', { attachmentId: 'res_missing' })).toEqual({ content: null, found: false });
    await invoke('vfs_delete_attachment', { attachmentId: id });
    // attachment_repo.rs:1874 deliberately reads deleted rows as well.
    expect(await invoke('vfs_get_attachment', { attachmentId: id })).toMatchObject({ id, deletedAt: expect.any(String) });
    expect(repos.attachments.listDeletedAttachments(db, 10, 0).map(item => item.id)).toContain(id);
  });
});

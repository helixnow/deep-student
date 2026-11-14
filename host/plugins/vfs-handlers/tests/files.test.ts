import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVfsHost, type VfsHost } from './harness.ts';
import { getBlobBase64, type FileDeps } from '../src/files.ts';

let vfs: VfsHost;
beforeEach(async () => { vfs = await createVfsHost(); }, 120_000);
afterEach(async () => { await vfs?.dispose(); }, 120_000);

const invoke = <T = unknown>(name: string, args: Record<string, unknown> = {}) =>
  vfs.host.invoke(name, args) as Promise<T>;
const repos = () => vfs.host.ctx.vfsRepo;
const db = () => vfs.storage.database('vfs');
const blobsDir = () => vfs.host.ctx.vfsDatabase.blobsDir();

function storeBlob(text: string, mimeType: string, extension: string): string {
  return repos().blobs.storeBlob(db(), blobsDir(), Buffer.from(text, 'utf8'), mimeType, extension).hash;
}

describe('vfs/handlers.rs file and blob commands', { timeout: 120_000 }, () => {
  it('vfs_get_file validates prefixes and returns the persisted row', async () => {
    const file = repos().files.createFile(db(), 'sha_get', 'a.txt', 5, 'file', 'text/plain', null, null);
    expect(await invoke('vfs_get_file', { fileId: file.id }))
      .toMatchObject({ id: file.id, fileName: 'a.txt', fileType: 'file' });
    expect(await invoke('vfs_get_file', { fileId: 'file_missing' })).toBeNull();
    await expect(invoke('vfs_get_file', { fileId: 'note_abc' }))
      .rejects.toBe('Invalid file ID format: note_abc');
  });

  it('vfs_list_files applies defaults and the type filter', async () => {
    repos().files.createFile(db(), 'sha_list_1', 'doc.pdf', 10, 'document', 'application/pdf', null, null);
    repos().files.createFile(db(), 'sha_list_2', 'pic.png', 20, 'image', 'image/png', null, null);
    repos().files.createFile(db(), 'sha_list_3', 'other.bin', 30, 'file', null, null, null);
    const all = await invoke<Array<{ id: string }>>('vfs_list_files');
    expect(all).toHaveLength(3);
    expect(await invoke<Array<{ fileType: string }>>('vfs_list_files', { fileType: 'image' }))
      .toEqual([expect.objectContaining({ fileType: 'image' })]);
    const first = await invoke<Array<{ id: string }>>('vfs_list_files', { limit: 1, offset: 1 });
    expect(first).toHaveLength(1);
  });

  it('vfs_get_file_content prefers the blob and falls back to inline resources', async () => {
    const blobHash = storeBlob('hello', 'text/plain', 'txt');
    const blobFile = repos().files.createFile(
      db(), 'sha_content_blob', 'hello.txt', 5, 'file', 'text/plain', blobHash, null,
    );
    expect(await invoke('vfs_get_file_content', { fileId: blobFile.id }))
      .toEqual({ content: Buffer.from('hello').toString('base64'), found: true });

    const inline = repos().files.createFile(
      db(), 'sha_content_inline', 'empty.txt', 0, 'file', 'text/plain', null, null,
    );
    expect(await invoke('vfs_get_file_content', { fileId: inline.id }))
      .toEqual({ content: '', found: true });

    expect(await invoke('vfs_get_file_content', { fileId: 'file_missing' }))
      .toEqual({ content: null, found: false });
    await expect(invoke('vfs_get_file_content', { fileId: 'note_abc' }))
      .rejects.toBe('Invalid file ID format: note_abc');
  });

  it('vfs_get_blob_base64 returns base64 metadata and explicit missing errors', async () => {
    const hash = storeBlob('image-bytes', 'image/png', 'png');
    expect(await invoke('vfs_get_blob_base64', { blobHash: hash })).toEqual({
      base64: Buffer.from('image-bytes').toString('base64'),
      mimeType: 'image/png',
      size: 11,
    });
    await expect(invoke('vfs_get_blob_base64', { blobHash: 'deadbeef' }))
      .rejects.toBe('Blob 不存在: deadbeef');
  });
  it('keeps blob connection, metadata and path errors separate', async () => {
    const hash = storeBlob('blob', 'image/png', 'png');
    const deps: FileDeps = { conn: db, files: repos().files, blobs: repos().blobs, resources: repos().resources,
      blobsDir, readBytes: path => vfs.host.ctx.files.readBytes(path), deleteIndex: async () => {}, log: vfs.host.ctx.logger };
    await expect(getBlobBase64({ ...deps, conn: () => { throw new Error('connection failure'); } }, hash))
      .rejects.toThrow('获取数据库连接失败: connection failure');
    const metadata = vi.spyOn(repos().blobs, 'getBlob').mockImplementationOnce(() => { throw new Error('metadata failure'); });
    await expect(getBlobBase64(deps, hash)).rejects.toThrow('获取 blob 元数据失败: metadata failure');
    metadata.mockRestore();
    const path = vi.spyOn(repos().blobs, 'getBlobPath').mockImplementationOnce(() => { throw new Error('path failure'); });
    await expect(getBlobBase64(deps, hash)).rejects.toThrow('获取 blob 路径失败: path failure');
    path.mockRestore();
  });

  it('vfs_delete_file soft deletes and tolerates unavailable vector cleanup', async () => {
    const file = repos().files.createFile(db(), 'sha_delete', 'gone.txt', 1, 'file', 'text/plain', null, null);
    expect(await invoke('vfs_delete_file', { fileId: file.id })).toBeNull();
    // Rust get_file 不过滤软删除行：status=deleted 仍可读。
    expect(await invoke('vfs_get_file', { fileId: file.id }))
      .toMatchObject({ id: file.id, status: 'deleted' });
    expect(db().pluck<number>("SELECT COUNT(*) FROM files WHERE id = ?1 AND status = 'deleted'", [file.id])).toBe(1);
    await expect(invoke('vfs_delete_file', { fileId: 'tb_abc' }))
      .rejects.toBe('Invalid file ID format: tb_abc');
  });

  it.each([null, 'text', 'multimodal'])('persists deletion outbox before Lance and soft deletes after %s failure', async failure => {
    const file = repos().files.createFile(db(), 'sha_order', 'order.txt', 1, 'file', 'text/plain', null, null);
    const resourceId = file.resourceId!;
    const unit = repos().embeddingUnits.create(db(), { resourceId, unitIndex: 0, textContent: 'text',
      imageBlobHash: null, imageMimeType: null, textSource: 'native' });
    repos().embeddingDims.register(db(), 768, 'text');
    repos().embeddingSegments.create(db(), { unitId: unit.id, segmentIndex: 0, modality: 'text', embeddingDim: 768,
      lanceRowId: 'delete_row', contentText: 'text', contentHash: null, startPos: null, endPos: null, metadataJson: null });
    db().run("UPDATE resources SET index_state='indexed',index_retry_count=4 WHERE id=?1", [resourceId]);
    db().run("UPDATE vfs_embedding_dims SET record_count=7 WHERE dimension=768 AND modality='text'");
    const calls: string[] = [];
    const snapshots: unknown[] = [];
    const legacyDelete = vi.spyOn(vfs.host.ctx.vfsIndex.indexing, 'deleteResourceIndex');
    // L12 now publishes `vfsIndex.lance` as a lifecycle Proxy (lance-disabled.ts:34-52)
    // whose methods are not own properties, so vi.spyOn cannot attach to it. The
    // command reads `vfsIndex.lance` per call (index.ts:342), so swap in a wrapper.
    const index = vfs.host.ctx.vfsIndex;
    const ownerLance = index.lance;
    const lanceDouble = { deleteByResource: (modality: string, id: string) => ownerLance.deleteByResource(modality, id) };
    index.lance = new Proxy(ownerLance, { get: (target, key) =>
      key === 'deleteByResource' ? lanceDouble.deleteByResource : Reflect.get(target, key) });
    const lance = vi.spyOn(lanceDouble, 'deleteByResource').mockImplementation(async modality => {
      calls.push(modality);
      // Capture here, assert after invoke: deleteFile intentionally catches Lance
      // errors, so assertions thrown inside this callback could be swallowed.
      snapshots.push({
        units: repos().embeddingUnits.getByResource(db(), resourceId),
        orphanRows: db().all('SELECT lance_row_id FROM __lance_orphan_queue'),
        dimensionCount: repos().embeddingDims.getByKey(db(), 768, 'text')!.recordCount,
        fileStatus: repos().files.getFile(db(), file.id)!.status,
      });
      if (modality === failure) throw new Error('Lance failed');
      return 0;
    });
    const warn = vi.spyOn(vfs.host.ctx.logger, 'warn');
    try {
      expect(await invoke('vfs_delete_file', { fileId: file.id })).toBeNull();
      expect(calls).toEqual(failure === 'text' ? ['text'] : ['text', 'multimodal']);
      expect(snapshots).toEqual(calls.map(() => ({ units: [], orphanRows: [{ lance_row_id: 'delete_row' }],
        dimensionCount: 0, fileStatus: 'active' })));
      expect(legacyDelete).not.toHaveBeenCalled();
      expect(repos().files.getFile(db(), file.id)!.status).toBe('deleted');
      expect(db().one('SELECT index_state,index_retry_count FROM resources WHERE id=?1', [resourceId]))
        .toEqual({ index_state: 'indexed', index_retry_count: 4 });
      if (failure !== null) expect(warn).toHaveBeenCalledWith(
        '[VfsFileRepo] Failed to cleanup index for file %s (resource %s): %s', file.id, resourceId, expect.any(Error));
    } finally { index.lance = ownerLance; lance.mockRestore(); warn.mockRestore(); legacyDelete.mockRestore(); }
  });
});

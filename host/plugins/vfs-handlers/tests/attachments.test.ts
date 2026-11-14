import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVfsHost, type VfsHost } from './harness.ts';
import type { AttachmentService } from '../src/attachments.ts';
import { content as readAttachment } from '../src/attachments.ts';
import memoryPlugin from '../../memory/index.ts';

const attachment = { id: 'att_1', type: 'image', name: 'x.png', mimeType: 'image/png', size: 4,
  contentHash: 'hash', isFavorite: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
function double() {
  return {
    getById: vi.fn<AttachmentService['getById']>(() => attachment),
    resolveFileId: vi.fn<AttachmentService['resolveFileId']>(() => 'file_1'),
    getContent: vi.fn<AttachmentService['getContent']>(() => 'YQ=='),
    getContentBounded: vi.fn<AttachmentService['getContentBounded']>(() => 'Yg=='),
    deleteAttachment: vi.fn<AttachmentService['deleteAttachment']>(),
  } satisfies AttachmentService;
}
let vfs: VfsHost;
let service: ReturnType<typeof double>;
beforeEach(async () => {
  service = double();
  const quiet = { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined, trace: () => undefined };
  vfs = await createVfsHost({ plugins: [memoryPlugin],
    provide: { log: { logger: (target: string) => ({ target, ...quiet }), write: () => undefined } } });
  const repo = vfs.host.ctx.vfsRepo.attachments;
  vi.spyOn(repo, 'getById').mockImplementation((_db, id) => service.getById(id));
  vi.spyOn(repo, 'resolveFileId').mockImplementation((_db, id) => service.resolveFileId(id));
  vi.spyOn(repo, 'getContent').mockImplementation((_db, _blobs, id) => service.getContent(id));
  vi.spyOn(repo, 'getContentBounded').mockImplementation((_db, _blobs, id, limit) => service.getContentBounded(id, limit));
  vi.spyOn(repo, 'deleteAttachment').mockImplementation((_db, id) => service.deleteAttachment(id));
}, 120_000);
afterEach(async () => { await vfs?.dispose(); });
const invoke = <T = unknown>(name: string, args: Record<string, unknown> = {}) => vfs.host.invoke(name, args) as Promise<T>;

describe('attachment config and command layer', { timeout: 120_000 }, () => {
  it('test_config_key_constants', async () => {
    const id = await invoke<string>('vfs_get_or_create_attachment_root_folder');
    const db = vfs.storage.database('vfs');
    expect(db.pluck("SELECT value FROM memory_config WHERE key = 'attachment_root_folder_id'")).toBe(id);
    expect(vfs.host.ctx.vfsRepo.folders.getFolder(db, id)?.title).toBe('附件');
  });
  it('V01-04 root folder commands run on the production ctx.vfs.attachmentConfig and L17 memoryConfig', async () => {
    expect(vfs.host.ctx.get('vfsAttachmentConfig')).toBeUndefined();
    const created = await invoke<string>('vfs_create_attachment_root_folder', { title: '附件' });
    expect(vfs.host.ctx.vfs.attachmentConfig.getRootFolderId()).toBe(created);
    const memoryConfig = vfs.host.ctx.get('memoryConfig') as { get(key: string): string | null };
    expect(memoryConfig.get('attachment_root_folder_id')).toBe(created);
    expect(await invoke('vfs_get_attachment_config')).toEqual({ attachmentRootFolderId: created, attachmentRootFolderTitle: '附件' });
  });
  it('creates/reuses the default root, replaces stale configuration and validates explicit roots', async () => {
    expect(await invoke('vfs_get_attachment_config')).toEqual({ attachmentRootFolderId: null, attachmentRootFolderTitle: null });
    const id = await invoke<string>('vfs_get_or_create_attachment_root_folder');
    expect(await invoke('vfs_get_or_create_attachment_root_folder')).toBe(id);
    expect(await invoke('vfs_get_attachment_config')).toEqual({ attachmentRootFolderId: id, attachmentRootFolderTitle: '附件' });
    const custom = await invoke<string>('vfs_create_attachment_root_folder', { title: 'Uploads' });
    expect(await invoke('vfs_get_attachment_config')).toEqual({ attachmentRootFolderId: custom, attachmentRootFolderTitle: 'Uploads' });
    await expect(invoke('vfs_set_attachment_root_folder', { folderId: 'fld_missing' })).rejects.toBe('Folder not found: fld_missing');
    expect(await invoke('vfs_set_attachment_root_folder', { folderId: id })).toBeNull();
    vfs.storage.database('vfs').run('UPDATE memory_config SET value=?1 WHERE key=?2', ['fld_missing', 'attachment_root_folder_id']);
    expect(await invoke('vfs_get_or_create_attachment_root_folder')).not.toBe(id);
  });
  it('preserves metadata and delete prefix asymmetry', async () => {
    expect(await invoke('vfs_get_attachment', { attachmentId: 'file_1' })).toEqual(attachment);
    await expect(invoke('vfs_get_attachment', { attachmentId: 'tb_1' })).rejects.toBe('Invalid attachment ID format: tb_1');
    await expect(invoke('vfs_delete_attachment', { attachmentId: 'file_1' })).rejects.toBe('Invalid attachment ID format: file_1');
    expect(await invoke('vfs_delete_attachment', { attachmentId: 'att_1' })).toBeNull();
    expect(service.deleteAttachment).toHaveBeenCalledWith('att_1');
  });
  it('resolves resource ids and distinguishes read errors from lookup errors', async () => {
    expect(await invoke('vfs_get_attachment_content', { attachmentId: 'res_1', maxBytes: 20 })).toEqual({ content: 'Yg==', found: true });
    expect(service.resolveFileId).toHaveBeenCalledWith('res_1');
    expect(service.getContentBounded).toHaveBeenCalledWith('file_1', 20);
    service.resolveFileId.mockReturnValueOnce(null);
    expect(await invoke('vfs_get_attachment_content', { attachmentId: 'res_missing' })).toEqual({ content: null, found: false });
    service.getContent.mockImplementationOnce(() => { throw new Error('read failed'); });
    expect(await invoke('vfs_get_attachment_content', { attachmentId: 'att_1' })).toEqual({ content: null, found: false, error: 'read failed' });
    service.resolveFileId.mockImplementationOnce(() => { throw new Error('lookup failed'); });
    await expect(invoke('vfs_get_attachment_content', { attachmentId: 'res_bad' })).rejects.toBe('lookup failed');
  });
  it('logs the Rust read error before returning the recoverable envelope', async () => {
    const error = vi.spyOn(vfs.host.ctx.logger, 'error');
    service.getContent.mockImplementationOnce(() => { throw new Error('read failed'); });
    expect(await readAttachment({ conn: () => vfs.storage.database('vfs'), blobsDir: () => vfs.host.ctx.vfsDatabase.blobsDir(),
      blobScope: () => vfs.host.ctx.files.scope(vfs.host.ctx.vfsDatabase.blobsDir()),
      config: vfs.host.ctx.vfs.attachmentConfig,
      folders: vfs.host.ctx.vfsRepo.folders, files: vfs.host.ctx.vfsRepo.files, service, log: vfs.host.ctx.logger }, 'att_1', null))
      .toEqual({ content: null, found: false, error: 'read failed' });
    expect(error).toHaveBeenCalledWith('[VFS::handlers] vfs_get_attachment_content: ERROR id=%s, error=%s', 'att_1', 'read failed');
    error.mockRestore();
  });
  it('reads img_ question blobs and rejects oversize data before the read', async () => {
    const db = vfs.storage.database('vfs'); const repos = vfs.host.ctx.vfsRepo;
    const blob = repos.blobs.storeBlob(db, vfs.host.ctx.vfsDatabase.blobsDir(), Buffer.from('image'), 'image/png', 'png');
    const exam = repos.exams.createExamSheet(db, { tempId: 'image-fixture', metadataJson: {}, previewJson: {} });
    db.run(`INSERT INTO questions (id,exam_id,content,question_type,images_json,created_at,updated_at)
      VALUES ('q_image',?1,'question','other',?2,'now','now')`, [exam.id, JSON.stringify([{ id: 'img_1', hash: blob.hash }])]);
    expect(await invoke('vfs_get_attachment_content', { attachmentId: 'img_1', maxBytes: 5 })).toEqual({ content: Buffer.from('image').toString('base64'), found: true });
    await expect(invoke('vfs_get_attachment_content', { attachmentId: 'img_1', maxBytes: 4 })).rejects.toBe('attachment content exceeds preview limit: 5 > 4 bytes');
    expect(await invoke('vfs_get_attachment_content', { attachmentId: 'img_missing' })).toEqual({ content: null, found: false });
  });
  it('RF-W04-blob-relative-path-escape: img_ reads never leave the blob directory', async () => {
    const db = vfs.storage.database('vfs'); const repos = vfs.host.ctx.vfsRepo;
    const blobsDir = vfs.host.ctx.vfsDatabase.blobsDir();
    const outside = join(dirname(blobsDir), 'outside.txt');
    writeFileSync(outside, 'secret');
    mkdirSync(join(blobsDir, 'ab'), { recursive: true });
    const cases: Array<[string, string]> = [['img_parent', '../outside.txt'], ['img_absolute', outside]];
    if (process.platform !== 'win32') {
      symlinkSync(outside, join(blobsDir, 'ab', 'link.png'));
      cases.push(['img_symlink', 'ab/link.png']);
    }
    const exam = repos.exams.createExamSheet(db, { tempId: 'escape-fixture', metadataJson: {}, previewJson: {} });
    const warn = vi.spyOn(vfs.host.ctx.logger, 'warn');
    for (const [id, relativePath] of cases) {
      db.run(`INSERT INTO blobs (hash, relative_path, size, mime_type, ref_count, created_at)
        VALUES (?1, ?2, 6, 'image/png', 1, 1)`, [`hash_${id}`, relativePath]);
      db.run(`INSERT INTO questions (id,exam_id,content,question_type,images_json,created_at,updated_at)
        VALUES (?1,?2,'question','other',?3,'now','now')`, [`q_${id}`, exam.id, JSON.stringify([{ id, hash: `hash_${id}` }])]);
      expect(await invoke('vfs_get_attachment_content', { attachmentId: id }), id).toEqual({ content: null, found: false });
      expect(warn).toHaveBeenCalledWith('[VFS::handlers] img_ blob path escapes the blob directory: hash=%s', `hash_${id}`);
    }
    warn.mockRestore();
  });
});

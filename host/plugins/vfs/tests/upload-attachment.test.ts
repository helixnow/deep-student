import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { append, beginIn, STAGED_UPLOAD_MAX_BYTES, stagingDir } from '../../../platform/storage/staged-upload.ts';
import * as vfsReposApi from '../../vfs-repos/api.ts';
import plugin from '../index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
// boundary-allow cross-plugin-impl: install real L10 notes plugin required by vfs
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: install real L11 vfs-repos plugin; attachments are written only through it
import reposPlugin from '../../vfs-repos/index.ts';
import { pdfPreviewNeedsCompression } from '../src/upload-attachment.ts';

interface UploadResult {
  sourceId: string; resourceHash: string; isNew: boolean;
  attachment: { id: string; name: string; mimeType: string; size: number; extractedText?: string };
  processingStatus?: string; processingPercent?: number; readyModes?: string[]; contentKind?: string;
}

// handlers.rs:1375 needs dstu-core media_types::media_kind, published by L11 api.ts (0a3d703ad, pending main).
const ownerMediaKindPublished = typeof (vfsReposApi as unknown as { mediaKind?: unknown }).mediaKind === 'function';

describe.skipIf(!ownerMediaKindPublished)('vfs_upload_attachment (production entry)', { timeout: 60_000 }, () => {
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let host: TestHost;
  const config = new Map<string, string>();
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-upload-attachment-'));
    storage = createStorageService({ baseDir: root, dataLocalDir: root });
    const report = await storage.migrations.runAll();
    expect(report.success, report.error ?? '').toBe(true);
    host = await createTestHost({ plugins: [pathsPlugin, notesPlugin, reposPlugin, indexPlugin, plugin], provide: {
      storage, memoryConfig: { get: (key: string) => config.get(key) ?? null,
        set: (key: string, value: string) => { config.set(key, value); } },
    }, app: { dataDir: root } });
  }, 120_000);
  afterAll(async () => { await host?.dispose(); storage?.dispose(); fs.rmSync(root, { recursive: true, force: true }); });

  it('uploads base64 text into the attachment root folder, then reuses by content hash', async () => {
    const base64Content = Buffer.from('hello attachment\n').toString('base64');
    const first = await host.invoke<UploadResult>('vfs_upload_attachment', { params: { name: 'a.txt', mimeType: 'text/plain', base64Content } });
    expect(first.isNew).toBe(true);
    expect(first.attachment.name).toBe('a.txt');
    // handlers.rs:1361-1371: no folderId → AttachmentConfig root folder is created and recorded
    expect(config.get('attachment_root_folder_id')).toBeTruthy();
    // handlers.rs:1547-1548: neither PDF nor image → no processing fields, no contentKind
    expect(first.processingStatus).toBeUndefined();
    expect(first.readyModes).toBeUndefined();
    expect(first.contentKind).toBeUndefined();
    const second = await host.invoke<UploadResult>('vfs_upload_attachment', { params: { name: 'a.txt', mimeType: 'text/plain', base64Content } });
    expect(second.isNew).toBe(false);
    expect(second.sourceId).toBe(first.sourceId);
  });

  it('takes a staged upload in preference to base64 and removes the staged file', async () => {
    const dir = stagingDir(path.join(root, 'cache'));
    const bytes = Buffer.from('staged body');
    const uploadId = beginIn(dir, 'b.txt', bytes.length, STAGED_UPLOAD_MAX_BYTES);
    append(uploadId, 0, new Uint8Array(bytes));
    const result = await host.invoke<UploadResult>('vfs_upload_attachment', {
      params: { name: 'b.txt', mimeType: 'text/plain', base64Content: '', stagedUploadId: uploadId },
    });
    expect(result.isNew).toBe(true);
    expect(result.attachment.size).toBe(bytes.length);
    // StagedFile drop: a second take fails because the upload was consumed
    await expect(host.invoke('vfs_upload_attachment', {
      params: { name: 'b.txt', mimeType: 'text/plain', stagedUploadId: uploadId },
    })).rejects.toBeTruthy();
  });

  it('rejects invalid base64 for media uploads with the Rust message prefix', async () => {
    await expect(host.invoke('vfs_upload_attachment', {
      params: { name: 'c.mp3', mimeType: 'audio/mpeg', base64Content: '***' },
    })).rejects.toContain('Base64 decode failed');
  });
});

describe('pdf_preview_needs_compression (handlers.rs:192-206)', () => {
  it('matches the Rust branch table', () => {
    const page = (extra: Record<string, unknown> = {}) => ({ pageIndex: 0, blobHash: 'b', width: 1, height: 1, mimeType: 'image/png', ...extra });
    const doc = (pages: unknown[]) => JSON.stringify({ pages, renderDpi: 150, totalPages: pages.length, renderedAt: 't' });
    expect(pdfPreviewNeedsCompression('not json')).toBe(false);
    expect(pdfPreviewNeedsCompression(doc([]))).toBe(false);
    expect(pdfPreviewNeedsCompression(doc([page({ compressedBlobHash: 'abc' })]))).toBe(false);
    expect(pdfPreviewNeedsCompression(doc([page({ compressedBlobHash: 'abc' }), page({ compressedBlobHash: ' ' })]))).toBe(true);
    expect(pdfPreviewNeedsCompression(doc([page()]))).toBe(true);
    // serde: missing required fields fail deserialization → false
    expect(pdfPreviewNeedsCompression(JSON.stringify({ pages: [page()] }))).toBe(false);
    expect(pdfPreviewNeedsCompression(doc([{ compressedBlobHash: '' }]))).toBe(false);
    // snake_case keys are not the serde wire format
    expect(pdfPreviewNeedsCompression(doc([page({ compressed_blob_hash: 'abc' })]))).toBe(true);
  });
});

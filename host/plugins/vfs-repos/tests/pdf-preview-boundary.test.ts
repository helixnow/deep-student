import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createTestHost } from '../../../kernel/testing.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import plugin from '../index.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';
import { pathsServiceDouble } from './support/paths-service.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
let blobsDir: string;
beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-preview-boundary-'));
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble() } });
  db = storage.database('vfs');
  blobsDir = join(storage.locations.activeDir, 'vfs_blobs');
}, 120_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);

// Rust types.rs:2851-2898 and attachment_repo.rs:2485-2509:
// deserialization is all-or-nothing; invalid previews cause no page ref mutations.
describe('V2-PDF-JSON production preview ownership', () => {
  function fixture(label: string) {
    const repos = host.ctx.vfsRepo;
    const page = repos.blobs.storeBlob(db, blobsDir, Buffer.from(label), 'image/png', 'png');
    const file = repos.files.createFile(db, `preview-${label}`, `${label}.pdf`, 10, 'document', 'application/pdf');
    return { page, file, preview: {
      pages: [{ pageIndex: 0, blobHash: page.hash, width: 1200, height: 1600, mimeType: 'image/png' }],
      renderDpi: 150, totalPages: 1, renderedAt: '2026-11-04T00:00:00+00:00',
    } };
  }

  it('purge_attachment skips every blob in a preview rejected by Rust serde', () => {
    const invalid = [
      (p: ReturnType<typeof fixture>['preview']) => JSON.stringify({ pages: p.pages }),
      (p: ReturnType<typeof fixture>['preview']) => JSON.stringify({ ...p, pages: [...p.pages, null] }),
      (p: ReturnType<typeof fixture>['preview']) => JSON.stringify({ ...p, pages: [{ ...p.pages[0], width: 4294967296 }] }),
      (p: ReturnType<typeof fixture>['preview']) => JSON.stringify({ ...p, renderDpi: 4294967296 }),
      (p: ReturnType<typeof fixture>['preview']) => JSON.stringify({ ...p, renderedAt: null }),
      (p: ReturnType<typeof fixture>['preview']) => JSON.stringify({ ...p, isTruncated: null }),
      (p: ReturnType<typeof fixture>['preview']) => JSON.stringify({ ...p, maxRenderedPages: null }),
      (p: ReturnType<typeof fixture>['preview']) => JSON.stringify(p).replace('"totalPages":1', '"totalPages":18446744073709551616'),
      (p: ReturnType<typeof fixture>['preview']) => JSON.stringify(p).replace('"renderDpi":150', '"renderDpi":150.0'),
      (p: ReturnType<typeof fixture>['preview']) => JSON.stringify(p).replace('"renderDpi":150', '"renderDpi":-0'),
      (p: ReturnType<typeof fixture>['preview']) => JSON.stringify({ ...p, pages: [{ ...p.pages[0], compressedBlobHash: false }] }),
    ];
    for (const [index, encode] of invalid.entries()) {
      const { page, file, preview } = fixture(`invalid-${index}`);
      host.ctx.vfsRepo.files.updatePdfPreviewOnly(db, file.id, encode(preview));
      expect(() => host.ctx.vfsRepo.attachments.purgeAttachmentWithConn(db, file.id), `case ${index}`).not.toThrow();
      expect(host.ctx.vfsRepo.files.getFile(db, file.id)).toBeNull();
      expect(host.ctx.vfsRepo.blobs.getBlob(db, page.hash)?.refCount, `case ${index}`).toBe(1);
    }
  });

  it('purge_attachment accepts legacy defaults, unknown fields and exact desktop usize maximum', () => {
    for (const large of [false, true]) {
      const { page, file, preview } = fixture(`valid-${large}`);
      let raw = JSON.stringify({ ...preview, unknownFutureField: true,
        pages: [{ ...preview.pages[0], compressedBlobHash: null, unknown: 1 }] });
      if (large) raw = raw.replace('"totalPages":1', '"totalPages":18446744073709551615');
      host.ctx.vfsRepo.files.updatePdfPreviewOnly(db, file.id, raw);
      host.ctx.vfsRepo.attachments.purgeAttachmentWithConn(db, file.id);
      expect(host.ctx.vfsRepo.blobs.getBlob(db, page.hash)?.refCount).toBe(0);
    }
  });

  it('copy_file uses the same serde boundary before increasing page references', () => {
    const { page, file, preview } = fixture('copy-invalid-width');
    host.ctx.vfsRepo.files.updatePdfPreviewOnly(db, file.id, JSON.stringify({ ...preview,
      pages: [{ ...preview.pages[0], width: 4294967296 }] }));
    const copy = host.ctx.vfsRepo.files.copyFile(db, file.id, 'copy.pdf');
    expect(copy.previewJson).toBe(host.ctx.vfsRepo.files.getFile(db, file.id)?.previewJson);
    expect(host.ctx.vfsRepo.blobs.getBlob(db, page.hash)?.refCount).toBe(1);
  });

  it('purge_attachment accepts serde field-order sequences and does not decrement compressed page blobs', () => {
    const { page, file } = fixture('sequence');
    const compressed = host.ctx.vfsRepo.blobs.storeBlob(db, blobsDir, Buffer.from('compressed'), 'image/jpeg', 'jpg');
    const raw = JSON.stringify([[[0, page.hash, 1200, 1600, 'image/png', compressed.hash]], 150, 1, 'date']);
    host.ctx.vfsRepo.files.updatePdfPreviewOnly(db, file.id, raw);
    host.ctx.vfsRepo.attachments.purgeAttachmentWithConn(db, file.id);
    expect(host.ctx.vfsRepo.blobs.getBlob(db, page.hash)?.refCount).toBe(0);
    // attachment_repo.rs:2487-2503 only touches blob_hash, unlike file_repo purge.
    expect(host.ctx.vfsRepo.blobs.getBlob(db, compressed.hash)?.refCount).toBe(1);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHost } from '../../../kernel/testing.ts';
import { notesServiceDouble } from './support/notes-service.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import plugin from '../index.ts';

const MAX_FILE_BYTES = 200 * 1024 * 1024;

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
let blobsDir: string;
let scratch: string;
beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-attachment-'));
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble(), 'notes': notesServiceDouble(() => storage.database('vfs')) } });
  db = storage.database('vfs');
  blobsDir = join(storage.locations.activeDir, 'vfs_blobs');
  scratch = mkdtempSync(join(tmpdir(), 'l11-attachment-scratch-'));
}, 120_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}, 120_000);
const attachments = () => host.ctx.vfsRepo.attachments;
const blobs = () => host.ctx.vfsRepo.blobs;

describe('attachment_repo.rs', { timeout: 120_000 }, () => {
  it('test_decode_base64_plain', () => {
    expect(Buffer.from(attachments().decodeBase64('SGVsbG8gV29ybGQ=')).toString('utf8')).toBe('Hello World');
  });

  it('test_decode_base64_data_url', () => {
    expect(Buffer.from(attachments().decodeBase64('data:text/plain;base64,SGVsbG8gV29ybGQ=')).toString('utf8')).toBe('Hello World');
  });

  it('test_decode_base64_checks_limit_before_allocating_output', () => {
    expect(() => attachments().decodeBase64Bounded('SGVsbG8=', 4)).toThrow(/Invalid argument/);
    expect(Buffer.from(attachments().decodeBase64Bounded('SGVsbG8=', 5)).toString('utf8')).toBe('Hello');
  });

  it('archive_magic_accepts_supported_formats', () => {
    expect(() => attachments().validateArchiveContent('bundle.zip', 'application/zip', Buffer.from('PK\x03\x04payload', 'latin1'))).not.toThrow();
    expect(() => attachments().validateArchiveContent('bundle.rar', 'application/vnd.rar', Buffer.from('Rar!\x1a\x07\x01\x00payload', 'latin1'))).not.toThrow();
    expect(() => attachments().validateArchiveContent('bundle.7z', 'application/x-7z-compressed', Buffer.from('\x37\x7a\xbc\xaf\x27\x1cpayload', 'latin1'))).not.toThrow();
  });

  it('archive_magic_rejects_spoofing_and_declared_mismatch', () => {
    expect(() => attachments().validateArchiveContent('bundle.zip', 'application/zip', Buffer.from('not an archive'))).toThrow(/Archive signature/);
    expect(() => attachments().validateArchiveContent('bundle.zip', 'application/x-7z-compressed', Buffer.from('PK\x03\x04payload', 'latin1'))).toThrow(/disagree/);
    expect(() => attachments().validateArchiveContent('bundle.rar', 'application/vnd.rar', Buffer.from('PK\x03\x04payload', 'latin1'))).toThrow(/Archive signature/);
  });

  it('test_read_file_bounded_rejects_oversized_sparse_file', () => {
    const path = join(scratch, 'oversized.bin');
    const fd = openSync(path, 'w');
    try { ftruncateSync(fd, MAX_FILE_BYTES + 1); }
    finally { closeSync(fd); }
    expect(() => attachments().readFileBounded(path, MAX_FILE_BYTES)).toThrow(/Invalid argument/);
  });

  it('test_is_probably_base64_rejects_path_like_content', () => {
    expect(attachments().isProbablyBase64('C:\\Users\\alice\\doc.docx')).toBe(false);
    expect(attachments().isProbablyBase64('/Users/alice/doc.docx')).toBe(false);
    expect(attachments().isProbablyBase64('file:///Users/alice/doc.docx')).toBe(false);
  });

  it('test_is_probably_base64_supports_urlsafe_without_padding', () => {
    expect(attachments().isProbablyBase64('YStiL2M')).toBe(true);
    expect(attachments().isProbablyBase64('data:application/octet-stream;base64,YStiL2M')).toBe(true);
  });

  it('test_compute_hash', () => {
    expect(attachments().computeHash(Buffer.from('test'))).toHaveLength(64);
  });

  it('test_infer_type_from_mime', () => {
    expect(attachments().inferTypeFromMime('image/png')).toBe('image');
    expect(attachments().inferTypeFromMime('image/jpeg')).toBe('image');
    expect(attachments().inferTypeFromMime('application/pdf')).toBe('file');
    expect(attachments().inferTypeFromMime('text/plain')).toBe('file');
  });

  it('test_infer_extension', () => {
    expect(attachments().inferExtension('image/png', 'test.png')).toBe('png');
    expect(attachments().inferExtension('image/jpeg', 'photo')).toBe('jpg');
    expect(attachments().inferExtension('application/pdf', 'document.pdf')).toBe('pdf');
  });

  it('test_is_safe_original_path_allows_textbooks_dir', () => {
    const slotRoot = join(scratch, 'slot');
    const blobsPath = join(slotRoot, 'blobs');
    const textbooksDir = join(slotRoot, 'textbooks');
    mkdirSync(blobsPath, { recursive: true });
    mkdirSync(textbooksDir, { recursive: true });
    const filePath = join(textbooksDir, 'test.docx');
    writeFileSync(filePath, 'docx-bytes');
    expect(attachments().isSafeOriginalPath(blobsPath, filePath)).toBe(true);
  });

  it('test_is_safe_original_path_rejects_external_path', () => {
    const slotRoot = join(scratch, 'slot-external');
    const blobsPath = join(slotRoot, 'blobs');
    mkdirSync(blobsPath, { recursive: true });
    const externalRoot = join(scratch, 'external');
    mkdirSync(externalRoot, { recursive: true });
    const externalFile = join(externalRoot, 'outside.docx');
    writeFileSync(externalFile, 'outside');
    expect(attachments().isSafeOriginalPath(blobsPath, externalFile)).toBe(false);
  });

  it('test_original_path_rejects_symlink_escaping_slot', () => {
    const slot = join(scratch, 'slot-symlink');
    const external = join(scratch, 'external-symlink');
    const blobsPath = join(slot, 'vfs_blobs');
    const textbooksDir = join(slot, 'textbooks');
    mkdirSync(blobsPath, { recursive: true });
    mkdirSync(textbooksDir, { recursive: true });
    mkdirSync(external, { recursive: true });
    const secret = join(external, 'secret.txt');
    writeFileSync(secret, 'outside-slot');
    const link = join(textbooksDir, 'leak.txt');
    symlinkSync(secret, link);

    expect(attachments().isSafeOriginalPath(blobsPath, link)).toBe(false);
    expect(attachments().resolveOriginalPath(blobsPath, 'att_symlink_escape', link)).toBeNull();
  });

  it('test_extract_relative_from_slot_path_macos', () => {
    expect(attachments().extractRelativeFromSlotPath(
      '/Users/alice/Library/Application Support/com.deepstudent.app/slots/slotA/textbooks/file.pptx'))
      .toBe('textbooks/file.pptx');
  });

  it('test_extract_relative_from_slot_path_windows', () => {
    expect(attachments().extractRelativeFromSlotPath(
      'C:\\Users\\bob\\AppData\\Local\\com.deepstudent.app\\slots\\slotB\\images\\abc.png'))
      .toBe('images/abc.png');
  });

  it('test_extract_relative_from_slot_path_nested', () => {
    expect(attachments().extractRelativeFromSlotPath('/data/app/slots/slotA/vfs_blobs/ab/cd/ef.bin'))
      .toBe('vfs_blobs/ab/cd/ef.bin');
  });

  it('test_extract_relative_from_slot_path_no_match', () => {
    expect(attachments().extractRelativeFromSlotPath('/Users/alice/Documents/file.pdf')).toBeNull();
    expect(attachments().extractRelativeFromSlotPath('relative/path/file.txt')).toBeNull();
  });

  it('test_extract_relative_from_slot_path_slot_root_only', () => {
    expect(attachments().extractRelativeFromSlotPath('/data/slots/slotA/')).toBeNull();
  });

  it('test_build_original_path_candidates_cross_platform_remap', () => {
    const slotRoot = join(scratch, 'slot-remap');
    const blobsPath = join(slotRoot, 'vfs_blobs');
    mkdirSync(blobsPath, { recursive: true });
    const foreignPath = '/Users/alice/Library/Application Support/com.deepstudent.app/slots/slotA/textbooks/test.pptx';
    const candidates = attachments().buildOriginalPathCandidates(blobsPath, foreignPath);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates).toContain(join(slotRoot, 'textbooks/test.pptx'));
  });

  it('resolve_file_id_maps_resource_ids_to_files', () => {
    const png = Buffer.from('\x89PNG\r\n\x1a\nquestion-figure', 'latin1');
    const blob = blobs().storeBlob(db, blobsDir, png, 'image/png', null);
    const now = Date.now();
    const ts = '2026-10-11T00:00:00Z';
    db.run(`INSERT INTO resources (id, hash, type, storage_mode, source_id, ref_count, created_at, updated_at)
      VALUES ('res_upload', 'h-upload', 'image', 'external', 'att_fig', 1, ?1, ?1)`, [now]);
    db.run(`INSERT INTO files (id, resource_id, blob_hash, sha256, file_name, mime_type, type, size, created_at, updated_at)
      VALUES ('att_fig', 'res_upload', ?1, 'sha-fig', 'fig.png', 'image/png', 'image', ?2, ?3, ?3)`,
    [blob.hash, png.length, ts]);
    db.run(`INSERT INTO resources (id, hash, type, storage_mode, data, source_id, ref_count, created_at, updated_at)
      VALUES ('res_ref', 'h-ref', 'image', 'inline', '{"refs":[]}', 'att_fig', 1, ?1, ?1),
             ('res_ref_indirect', 'h-ref2', 'image', 'inline', '{"refs":[]}', 'res_upload', 1, ?1, ?1),
             ('res_note', 'h-note', 'note', 'inline', '# note', 'note_1', 1, ?1, ?1)`, [now]);

    expect(attachments().resolveFileId(db, 'att_fig')).toBe('att_fig');
    expect(attachments().resolveFileId(db, 'file_other')).toBe('file_other');
    expect(attachments().resolveFileId(db, 'res_upload')).toBe('att_fig');
    expect(attachments().resolveFileId(db, 'res_ref')).toBe('att_fig');
    expect(attachments().resolveFileId(db, 'res_ref_indirect')).toBe('att_fig');
    expect(attachments().resolveFileId(db, 'res_note')).toBeNull();
    expect(attachments().resolveFileId(db, 'res_missing')).toBeNull();

    const fileId = attachments().resolveFileId(db, 'res_ref')!;
    const content = attachments().getContent(db, blobsDir, fileId);
    expect(content).not.toBeNull();
    expect(Buffer.from(content!, 'base64').equals(png)).toBe(true);
  });

  // L04 attachment_stage_executor.rs:1350-1362: raw COALESCE(r.data, '') read, no decode/trim.
  it('getInlineDataWithConn returns raw inline data, empty without data and null for missing/deleted files', () => {
    const files = host.ctx.vfsRepo.files;
    const file = files.createFile(db, 'inline-raw-sha', 'raw.txt', 4, 'document', 'text/plain');
    db.run('UPDATE resources SET data = ?1 WHERE id = (SELECT resource_id FROM files WHERE id = ?2)',
      ['  data:text/plain;base64,QUJD  ', file.id]);
    expect(attachments().getInlineDataWithConn(db, file.id)).toBe('  data:text/plain;base64,QUJD  ');

    db.run('UPDATE resources SET data = NULL WHERE id = (SELECT resource_id FROM files WHERE id = ?1)', [file.id]);
    expect(attachments().getInlineDataWithConn(db, file.id)).toBe('');
    // files.resource_id is a foreign key; the "no resource" case is a NULL link (LEFT JOIN miss).
    db.run('UPDATE files SET resource_id = NULL WHERE id = ?1', [file.id]);
    expect(attachments().getInlineDataWithConn(db, file.id)).toBe('');

    expect(attachments().getInlineDataWithConn(db, 'file_missing')).toBeNull();
    files.deleteFile(db, file.id);
    expect(attachments().getInlineDataWithConn(db, file.id)).toBeNull();
  });
});

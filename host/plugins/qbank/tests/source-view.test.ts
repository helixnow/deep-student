import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import files from '../../../platform/files/index.ts';
import { createOpfsFiles, mobileRoots } from '../../../platform/files/opfs.ts';
import { createFakeOpfs } from '../../../platform/files/tests/__fixtures__/fake-opfs.ts';
import qbank from '../index.ts';
import type { SourceImageInfo, SourcePageView } from '../api.ts';

const NOW = '2026-01-01T00:00:00+00:00';

async function fixture(options: { mobileFiles?: boolean } = {}) {
  const { storage, base } = await createMigratedStorage('qbank-source-view-');
  // 桌面装 W14 files 插件；移动端 profile 的 ctx.files 是 OPFS 实现（mobile.json）。
  const mobileFiles = options.mobileFiles ? createOpfsFiles({ root: createFakeOpfs(), roots: mobileRoots(base) }) : null;
  const host = await createTestHost({
    plugins: mobileFiles === null ? [files, qbank] : [qbank],
    provide: {
      ...(mobileFiles === null ? {} : { files: mobileFiles }),
      storage,
      paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32'
        : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }),
    },
  });
  const db = storage.database('vfs');
  db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json,
      created_at, updated_at)
    VALUES ('exam_1', 'source view test', 'completed', 'tmp_source_view', '{}', '{"pages":[]}', ?1, ?1)`,
  [NOW]);
  const blobsDir = path.join(storage.locations.activeDir, 'vfs_blobs');
  return {
    host, db, storage, blobsDir, mobileFiles,
    insertSource(sourceId: string, descriptor: unknown, examId = 'exam_1'): void {
      db.run(`INSERT INTO qbank_sources (id, exam_id, source_key, descriptor_json, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
      [sourceId, examId, `key:${sourceId}`, JSON.stringify(descriptor), NOW]);
    },
    insertFile(fileId: string, fileName: string, fileType: string, mimeType: string,
      blobHash: string, pageCount: number | null): void {
      db.run(`INSERT OR IGNORE INTO blobs (hash, relative_path, size, mime_type, ref_count, created_at)
        VALUES (?1, 'test', 8, ?2, 1, 0)`, [blobHash, mimeType]);
      db.run(`INSERT INTO files (id, blob_hash, sha256, file_name, original_path, size, page_count,
          type, mime_type, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, 8, ?6, ?7, ?8, ?9, ?9)`,
      [fileId, blobHash, `sha:${fileId}`, fileName, `/library/${fileName}`, pageCount,
        fileType, mimeType, NOW]);
    },
    async sourcePage(sourceId: string, page: number | null): Promise<SourcePageView> {
      return host.invoke('qbank_get_source_page', { examId: 'exam_1', sourceId, page }) as Promise<SourcePageView>;
    },
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function pagedDescriptor(): Record<string, unknown> {
  return {
    source_id: 's1',
    name: 'midterm.pdf',
    format: 'pdf',
    page_count: 2,
    original_path: '/library/midterm.pdf',
    pages: [
      { source_id: 's1', page: 1, blob_hash: 'blob_page_1', width: 1200, height: 1600, text_hint: 'Page one' },
      { source_id: 's1', page: 2, blob_hash: 'blob_page_2', width: 1200, height: 1600, text_hint: 'Page two' },
    ],
  };
}

describe('qbank_source_view.rs', () => {
  it('resolves_a_real_page_and_keeps_the_database_source_id', async () => {
    const f = await fixture();
    try {
      f.insertSource('qsource_db_1', pagedDescriptor());
      const view = await f.sourcePage('qsource_db_1', 2);
      expect(view.source_id).toBe('qsource_db_1');
      expect(view.page).toBe(2);
      expect(view.blob_hash).toBe('blob_page_2');
      expect(view.width).toBe(1200);
      expect(view.height).toBe(1600);
      expect(view.text).toBe('Page two');
      expect(view.available_pages).toEqual([1, 2]);
      expect(view.source_name).toBe('midterm.pdf');
      expect(view.original_path).toBe('/library/midterm.pdf');
    } finally { await f.dispose(); }
  });

  it('a_page_less_source_returns_native_text_without_fabricating_page_one', async () => {
    const f = await fixture();
    try {
      f.insertSource('qsource_text', {
        source_id: 'r1_s1', name: 'lecture-transcript.txt', format: 'media_transcript',
        page_count: null, original_path: '/library/lecture-transcript.txt', text: 'Native text layer',
      });
      const view = await f.sourcePage('qsource_text', null);
      expect(view.page).toBeNull();
      expect(view.blob_hash).toBeNull();
      expect(view.width).toBeNull();
      expect(view.height).toBeNull();
      expect(view.text).toBe('Native text layer');
      expect(view.original_path).toBe('/library/lecture-transcript.txt');
      expect(view.available_pages).toEqual([]);
    } finally { await f.dispose(); }
  });

  it('a_missing_page_is_reported_without_substituting_another_image', async () => {
    const f = await fixture();
    try {
      f.insertSource('qsource_db_1', pagedDescriptor());
      const view = await f.sourcePage('qsource_db_1', 9);
      expect(view.page).toBe(9);
      expect(view.blob_hash).toBeNull();
      expect(view.available_pages).toEqual([1, 2]);
    } finally { await f.dispose(); }
  });

  it('a_source_from_another_or_deleted_exam_is_rejected', async () => {
    const f = await fixture();
    const other = await fixture();
    try {
      other.insertSource('qsource_other', pagedDescriptor());
      await expect(f.sourcePage('qsource_other', 1)).rejects.toMatchObject({
        error_type: 'NotFound', message: expect.stringContaining('来源不存在') as string,
      });
      await f.host.invoke('qbank_get_source_page', { examId: 'exam_missing', sourceId: 'qsource_other', page: 1 })
        .then(() => { throw new Error('must reject'); }, (error: unknown) => {
          expect(error).toMatchObject({
            error_type: 'NotFound', message: expect.stringContaining('题目集不存在') as string,
          });
        });
      f.db.run("UPDATE exam_sheets SET deleted_at = ?1 WHERE id = 'exam_1'", [NOW]);
      await expect(f.sourcePage('qsource_db_1', 1)).rejects.toMatchObject({
        error_type: 'NotFound', message: expect.stringContaining('题目集不存在') as string,
      });
    } finally {
      await f.dispose();
      await other.dispose();
    }
  });

  it('malformed_descriptors_are_not_treated_as_an_empty_page', async () => {
    const f = await fixture();
    try {
      f.db.run(`INSERT INTO qbank_sources (id, exam_id, source_key, descriptor_json, created_at, updated_at)
        VALUES ('qsource_bad', 'exam_1', 'key:bad', '{not-json', ?1, ?1)`, [NOW]);
      await expect(f.sourcePage('qsource_bad', 1)).rejects.toMatchObject({
        error_type: 'Database', message: expect.stringContaining('来源描述无效') as string,
      });
    } finally { await f.dispose(); }
  });

  it('chat_attachment_refs_fall_back_to_the_original_vfs_image', async () => {
    const f = await fixture();
    try {
      f.insertFile('att_chat_image', 'chat-figure.png', 'image', 'image/png', 'blob_chat_image', null);
      const view = await f.sourcePage('att_chat_image', 1);
      expect(view.source_id).toBe('att_chat_image');
      expect(view.page).toBe(1);
      expect(view.blob_hash).toBe('blob_chat_image');
      expect(view.source_name).toBe('chat-figure.png');
      expect(view.source_format).toBe('png');
      expect(view.page_count).toBe(1);
      expect(view.available_pages).toEqual([1]);
      expect(view.original_path).toBe('/library/chat-figure.png');
    } finally { await f.dispose(); }
  });

  it('chat_attachment_pdf_exposes_metadata_but_never_document_bytes_as_a_page', async () => {
    const f = await fixture();
    try {
      f.insertFile('att_chat_pdf', 'chat-notes.pdf', 'document', 'application/pdf', 'blob_chat_pdf', 12);
      const view = await f.sourcePage('att_chat_pdf', 3);
      expect(view.page).toBe(3);
      expect(view.blob_hash).toBeNull();
      expect(view.source_name).toBe('chat-notes.pdf');
      expect(view.source_format).toBe('pdf');
      expect(view.page_count).toBe(12);
      expect(view.available_pages).toEqual([]);
      expect(view.original_path).toBe('/library/chat-notes.pdf');
    } finally { await f.dispose(); }
  });

  it('chat_attachment_pdf_uses_cached_actual_page_images', async () => {
    const f = await fixture();
    try {
      f.insertFile('att_cached_pdf', 'cached.pdf', 'document', 'application/pdf', 'original_pdf_bytes', 18);
      f.db.run(`UPDATE files SET preview_json = ?1 WHERE id = 'att_cached_pdf'`, [JSON.stringify({
        pages: [{ pageIndex: 2, blobHash: 'actual_page_three', width: 1133, height: 1600 }],
      })]);
      const view = await f.sourcePage('att_cached_pdf', 3);
      expect(view.blob_hash).toBe('actual_page_three');
      expect(view.available_pages).toEqual([3]);
      expect(view.width).toBe(1133);
      const missing = await f.sourcePage('att_cached_pdf', 4);
      expect(missing.blob_hash).toBeNull();
    } finally { await f.dispose(); }
  });

  it('an_image_attachment_does_not_claim_to_have_a_second_page', async () => {
    const f = await fixture();
    try {
      f.insertFile('att_chat_image', 'chat-figure.png', 'image', 'image/png', 'blob_chat_image', null);
      const view = await f.sourcePage('att_chat_image', 2);
      expect(view.page).toBe(2);
      expect(view.blob_hash).toBeNull();
      expect(view.available_pages).toEqual([1]);
    } finally { await f.dispose(); }
  });

  it('an_unknown_attachment_still_fails_explicitly', async () => {
    const f = await fixture();
    try {
      await expect(f.sourcePage('att_missing', 1)).rejects.toMatchObject({
        error_type: 'NotFound', message: expect.stringContaining('来源不存在') as string,
      });
    } finally { await f.dispose(); }
  });

  it('get_source_images_reads_metadata_hashes_then_preview_and_skips_missing_blobs', async () => {
    const f = await fixture();
    try {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      const hash = 'a'.repeat(64);
      const relative = path.join(hash.slice(0, 2), `${hash}.png`);
      const target = path.join(f.blobsDir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, png);
      f.db.run(`INSERT INTO blobs (hash, relative_path, size, mime_type, ref_count, created_at)
        VALUES (?1, ?2, ?3, 'image/png', 1, ?4)`, [hash, relative, png.length, Date.now()]);
      f.db.run("UPDATE exam_sheets SET metadata_json = ?1 WHERE id = 'exam_1'",
        [JSON.stringify({ source_image_hashes: [hash] })]);
      const expected = [{ blobHash: hash, dataUrl: `data:image/png;base64,${png.toString('base64')}`,
        pageIndex: 0 }];
      expect(await f.host.invoke('qbank_get_source_images', { examId: 'exam_1' })).toEqual(expected);

      f.db.run(`UPDATE exam_sheets SET metadata_json = '{}', preview_json = ?1 WHERE id = 'exam_1'`,
        [JSON.stringify({ pages: [{ blob_hash: hash }] })]);
      expect(await f.host.invoke('qbank_get_source_images', { examId: 'exam_1' })).toEqual(expected);

      f.db.run(`UPDATE exam_sheets SET metadata_json = ?1, preview_json = ?2 WHERE id = 'exam_1'`, [
        JSON.stringify({ source_image_hashes: ['missing_hash'] }),
        JSON.stringify({ pages: [{ blob_hash: hash }] }),
      ]);
      const fromPreview = await f.host.invoke('qbank_get_source_images', { examId: 'exam_1' }) as SourceImageInfo[];
      expect(fromPreview).toEqual([]);
      await expect(f.host.invoke('qbank_get_source_images', { examId: 'missing' })).rejects.toMatchObject({
        error_type: 'NotFound', message: '题目集不存在',
      });
    } finally { await f.dispose(); }
  });

  // OPFS 只接受 POSIX 绝对路径作根；win32 的临时目录不能充当移动端根。
  it.skipIf(process.platform === 'win32')('mobile_profile_reads_source_images_through_opfs_files', async () => {
    const f = await fixture({ mobileFiles: true });
    try {
      const hash = 'e'.repeat(64);
      const relative = `${hash.slice(0, 2)}/${hash}.png`;
      const png = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 1, 2, 3]);
      await f.mobileFiles!.writeBytes(`${f.blobsDir}/${relative}`, png, { createParents: true });
      f.db.run(`INSERT INTO blobs (hash, relative_path, size, mime_type, ref_count, created_at)
        VALUES (?1, ?2, ?3, 'image/png', 1, ?4)`, [hash, relative, png.length, Date.now()]);
      f.db.run(`INSERT INTO blobs (hash, relative_path, size, mime_type, ref_count, created_at)
        VALUES (?1, '../../outside.png', 1, 'image/png', 1, ?2)`, ['f'.repeat(64), Date.now()]);
      f.db.run("UPDATE exam_sheets SET metadata_json = ?1 WHERE id = 'exam_1'",
        [JSON.stringify({ source_image_hashes: ['f'.repeat(64), hash] })]);
      expect(await f.host.invoke('qbank_get_source_images', { examId: 'exam_1' })).toEqual([
        { blobHash: hash, dataUrl: `data:image/png;base64,${Buffer.from(png).toString('base64')}`, pageIndex: 1 },
      ]);
    } finally { await f.dispose(); }
  });

  it('get_source_images_sniffs_webp_by_raw_bytes_like_rust', async () => {
    // commands.rs:8575 `data.starts_with(b"RIFF") && data.len() > 12 && &data[8..12] == b"WEBP"`。
    const f = await fixture();
    try {
      const blobs: [string, number[]][] = [
        ['b'.repeat(64), [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56]],
        ['c'.repeat(64), [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]],
        ['d'.repeat(64), [0xd2, 0xc9, 0xc6, 0xc6, 0, 0, 0, 0, 0xd7, 0xc5, 0xc2, 0xd0, 0x56]],
      ];
      for (const [hash, bytes] of blobs) {
        const relative = path.join(hash.slice(0, 2), `${hash}.bin`);
        const target = path.join(f.blobsDir, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, Uint8Array.from(bytes));
        f.db.run(`INSERT INTO blobs (hash, relative_path, size, mime_type, ref_count, created_at)
          VALUES (?1, ?2, ?3, NULL, 1, ?4)`, [hash, relative, bytes.length, Date.now()]);
      }
      f.db.run("UPDATE exam_sheets SET metadata_json = ?1 WHERE id = 'exam_1'",
        [JSON.stringify({ source_image_hashes: blobs.map(([hash]) => hash) })]);
      const images = await f.host.invoke('qbank_get_source_images', { examId: 'exam_1' }) as SourceImageInfo[];
      expect(images.map((image) => image.dataUrl)).toEqual([
        'data:image/webp;base64,UklGRgAAAABXRUJQVg==',
        'data:image/png;base64,UklGRgAAAABXRUJQ',
        'data:image/png;base64,0snGxgAAAADXxcLQVg==',
      ]);
    } finally { await f.dispose(); }
  });
});

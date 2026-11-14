/**
 * `src/commands.rs::qbank_crop_source_image` 的生产入口冒烟：
 * 源 blob → 相对坐标裁剪 → PNG blob → VFS 文件 → 题目 images 追加。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import native from '../../../platform/native/index.ts';
import files from '../../../platform/files/index.ts';
import { createOpfsFiles, mobileRoots } from '../../../platform/files/opfs.ts';
import { createFakeOpfs } from '../../../platform/files/tests/__fixtures__/fake-opfs.ts';
import type { QuestionImage, VfsReposService } from '../../vfs-repos/api.ts';
import qbank from '../index.ts';
import type { Question } from '../api.ts';
import { cropImageCodecOf } from '../src/native-image.ts';

const NOW = '2026-01-01T00:00:00+00:00';
/** 10×10 红色 PNG；仅作为源图 fixture，生产路径完全走 nativeImage 解码/裁剪/编码。 */
const SOURCE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVR4nGP4z8DwnxjMMKrwP12DBwCSw8c5lI9cnwAAAABJRU5ErkJggg==';

async function fixture(extraProvide: Record<string, unknown> = {}, options: { mobileFiles?: boolean } = {}) {
  const { storage, base } = await createMigratedStorage('qbank-crop-');
  // 移动端 profile：ctx.files 是 OPFS 实现（mobile.json），允许根取 mobileRoots。
  const mobileFiles = options.mobileFiles ? createOpfsFiles({ root: createFakeOpfs(), roots: mobileRoots(base) }) : null;
  const host = await createTestHost({
    // 生产组合：F7 native 插件提供 nativeImage、W14 files 插件提供 ctx.files；契约用例显式传入 nativeImage 时不装 native，避免重复提供。
    plugins: [
      ...(extraProvide.nativeImage === undefined ? [native] : []), ...(mobileFiles === null ? [files] : []), qbank, vfsRepos,
    ],
    provide: {
      ...(mobileFiles === null ? {} : { files: mobileFiles }),
      storage,
      paths: createPaths({
        dataDir: base,
        platform: process.platform === 'win32' ? 'win32'
          : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-test-device' },
      }),
      ...extraProvide,
    },
  });
  const db = storage.database('vfs');
  db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json,
      created_at, updated_at)
    VALUES ('exam_1', '裁剪', 'completed', 't1', '{}', '{}', ?1, ?1)`, [NOW]);
  return {
    host, db, storage, mobileFiles,
    blobsDir: path.join(storage.locations.activeDir, 'vfs_blobs'),
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

describe('qbank_crop_source_image', () => {
  it('crops_relative_region_stores_png_and_appends_question_image', async () => {
    const f = await fixture();
    try {
      // 真实 F7 native 插件必须提供裁剪/编码能力；缺失即失败，不跳过。
      expect(cropImageCodecOf(f.host.ctx)).not.toBeNull();
      const repos = f.host.ctx.vfsRepo as VfsReposService;
      const source = Buffer.from(SOURCE_PNG, 'base64');
      const sourceBlob = repos.blobs.storeBlob(f.db, f.blobsDir, source, 'image/png', 'png');

      const question = await f.host.invoke<Question>('qbank_create_question', {
        params: { exam_id: 'exam_1', content: '裁剪源图' },
      });

      const image = await f.host.invoke<QuestionImage>('qbank_crop_source_image', {
        request: {
          question_id: question.id,
          blob_hash: sourceBlob.hash,
          crop_x: 0.25,
          crop_y: 0.25,
          crop_width: 0.5,
          crop_height: 0.5,
        },
      });

      expect(image.id.startsWith('file_')).toBe(true);
      expect(image.name.startsWith('crop_')).toBe(true);
      expect(image.name.endsWith('.png')).toBe(true);
      expect(image.mime).toBe('image/png');
      expect(image.role).toBe('question');
      expect(image.hash).not.toBe(sourceBlob.hash);

      const stored = fs.readFileSync(repos.blobs.getBlobPath(f.db, f.blobsDir, image.hash)!);
      const metadata = await f.host.ctx.nativeImage.dimensions(stored);
      expect([metadata.width, metadata.height]).toEqual([5, 5]);

      const updated = await f.host.invoke<Question>('qbank_get_question', {
        questionId: question.id,
      });
      expect(updated.images).toEqual([image]);
    } finally {
      await f.dispose();
    }
  });

  it('crop_uses_relative_coordinates_and_native_image_contract', async () => {
    let bbox: { x: number; y: number; width: number; height: number } | null = null;
    const encoded: number[] = [];
    const nativeImage = {
      async decodeRgba() {
        return { width: 10, height: 10, rgba: new Uint8Array(10 * 10 * 4) };
      },
      cropRgba(input: { width: number; height: number; rgba: Uint8Array },
        rect: { x: number; y: number; width: number; height: number }) {
        bbox = rect;
        return { width: rect.width, height: rect.height,
          rgba: new Uint8Array(rect.width * rect.height * 4) };
      },
      async encode() {
        // 只验证命令把 nativeImage 的 PNG 字节原样落 blob，不复制 F7 的编码实现。
        const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
        encoded.push(...bytes);
        return bytes;
      },
    };
    const f = await fixture({ nativeImage });
    try {
      const repos = f.host.ctx.vfsRepo as VfsReposService;
      const sourceBlob = repos.blobs.storeBlob(
        f.db, f.blobsDir, Buffer.from(SOURCE_PNG, 'base64'), 'image/png', 'png');
      const question = await f.host.invoke<Question>('qbank_create_question', {
        params: { exam_id: 'exam_1', content: '契约裁剪' },
      });

      const image = await f.host.invoke<QuestionImage>('qbank_crop_source_image', {
        request: {
          question_id: question.id, blob_hash: sourceBlob.hash,
          crop_x: 0.25, crop_y: 0.25, crop_width: 0.5, crop_height: 0.5,
        },
      });

      expect(bbox).toEqual({ x: 3, y: 3, width: 5, height: 5 });
      expect(encoded).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(fs.readFileSync(repos.blobs.getBlobPath(f.db, f.blobsDir, image.hash)!))
        .toEqual(Buffer.from(encoded));
      expect(image).toMatchObject({ mime: 'image/png', role: 'question' });
    } finally { await f.dispose(); }
  });

  it('missing_source_blob_returns_not_found_and_does_not_touch_question', async () => {
    const f = await fixture();
    try {
      const question = await f.host.invoke<Question>('qbank_create_question', {
        params: { exam_id: 'exam_1', content: '缺少源图' },
      });
      await expect(f.host.invoke('qbank_crop_source_image', {
        request: {
          question_id: question.id,
          blob_hash: 'f'.repeat(64),
          crop_x: 0,
          crop_y: 0,
          crop_width: 1,
          crop_height: 1,
        },
      })).rejects.toMatchObject({ error_type: 'NotFound', message: '源图片 Blob 不存在' });

      const updated = await f.host.invoke<Question>('qbank_get_question', {
        questionId: question.id,
      });
      expect(updated.images).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  // OPFS 只接受 POSIX 绝对路径作根；win32 的临时目录不能充当移动端根。
  it.skipIf(process.platform === 'win32')('mobile_profile_reads_the_source_blob_through_opfs_files', async () => {
    const f = await fixture({}, { mobileFiles: true });
    try {
      const repos = f.host.ctx.vfsRepo as VfsReposService;
      const source = Buffer.from(SOURCE_PNG, 'base64');
      const sourceBlob = repos.blobs.storeBlob(f.db, f.blobsDir, source, 'image/png', 'png');
      const blobPath = repos.blobs.getBlobPath(f.db, f.blobsDir, sourceBlob.hash)!;
      await f.mobileFiles!.writeBytes(blobPath, new Uint8Array(source), { createParents: true });
      fs.rmSync(blobPath);
      const question = await f.host.invoke<Question>('qbank_create_question', {
        params: { exam_id: 'exam_1', content: '移动端裁剪' },
      });
      const image = await f.host.invoke<QuestionImage>('qbank_crop_source_image', {
        request: { question_id: question.id, blob_hash: sourceBlob.hash, crop_x: 0.25, crop_y: 0.25, crop_width: 0.5, crop_height: 0.5 },
      });
      expect(image).toMatchObject({ mime: 'image/png', role: 'question' });
      expect(image.name).toBe(`crop_${image.hash.slice(0, 8)}.png`);
    } finally {
      await f.dispose();
    }
  });

  // commands.rs `std::fs::read(&blob_path)` 的 io::Error Display；win32 文案另有平台表，不在此断言。
  it.skipIf(process.platform === 'win32')('unreadable_source_blob_reports_the_rust_io_error_text', async () => {
    const f = await fixture();
    try {
      const repos = f.host.ctx.vfsRepo as VfsReposService;
      const sourceBlob = repos.blobs.storeBlob(f.db, f.blobsDir, Buffer.from(SOURCE_PNG, 'base64'), 'image/png', 'png');
      fs.rmSync(repos.blobs.getBlobPath(f.db, f.blobsDir, sourceBlob.hash)!);
      const question = await f.host.invoke<Question>('qbank_create_question', {
        params: { exam_id: 'exam_1', content: '源图文件丢失' },
      });
      await expect(f.host.invoke('qbank_crop_source_image', {
        request: { question_id: question.id, blob_hash: sourceBlob.hash, crop_x: 0, crop_y: 0, crop_width: 1, crop_height: 1 },
      })).rejects.toEqual({
        error_type: 'FileSystem', message: '读取源图片失败: No such file or directory (os error 2)', details: null,
      });
    } finally {
      await f.dispose();
    }
  });
});

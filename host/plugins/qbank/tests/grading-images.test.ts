/**
 * `qbank_grading/pipeline.rs::guess_image_mime_*` 与
 * `src/qbank_grading/image_answer/tests.rs::reads_synced_image_answer_after_file_id_deduplication`。
 *
 * 跨设备同步的落库属于 L20；这里在真实 vfs 表上构造同步完成后的规范行 + ID 别名，
 * 验证 qbank 的图片作答读取（信封保留远端 ID）仍然可取到内容。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import {
  fetchImageAnswerContents, guessImageMime,
} from '../src/grading-images.ts';
import { parseImageAnswerEnvelope } from '../src/image-answer.ts';

function base64Bytes(bytes: number[]): string {
  return Buffer.from(bytes).toString('base64');
}

async function fixture() {
  const { storage, base } = await createMigratedStorage('qbank-grading-images-');
  const host = await createTestHost({
    plugins: [vfsRepos],
    provide: {
      storage,
      paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32'
        : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }),
    },
  });
  const db = storage.database('vfs');
  const blobsDir = path.join(storage.locations.activeDir, 'vfs_blobs');
  return {
    base, host, db, blobsDir,
    vfsRepo: host.ctx.vfsRepo as VfsReposService,
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

describe('qbank_grading/image_answer.rs', () => {
  it('guess_image_mime_detects_png_and_jpeg_magics', () => {
    const pngHead = base64Bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    expect(guessImageMime(pngHead)).toBe('image/png');
    const jpgHead = base64Bytes([0xff, 0xd8, 0xff, 0xe0]);
    expect(guessImageMime(jpgHead)).toBe('image/jpeg');
    expect(guessImageMime('data:image/webp;base64,AAAA')).toBe('image/webp');
    expect(guessImageMime('')).toBe('image/jpeg');
  });

  it('guess_image_mime_detects_bare_base64_gif_versions', () => {
    for (const header of ['GIF87a', 'GIF89a']) {
      const bytes = [...Buffer.from(header, 'latin1'),
        1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 0xff, 0xff];
      expect(guessImageMime(base64Bytes(bytes))).toBe('image/gif');
    }
  });

  it('guess_image_mime_decodes_the_head_with_strict_standard_base64', () => {
    // pipeline.rs:1046 `STANDARD.decode(head)`：解码失败就不看魔数，兜底 JPEG。
    expect(guessImageMime('iVBORw0KGgo=')).toBe('image/png');
    expect(guessImageMime('iVBORw0KGgo')).toBe('image/jpeg');
    expect(guessImageMime('iVBO Rw0KGgo=')).toBe('image/jpeg');
    expect(guessImageMime('data:application/octet-stream;base64,R0lGODlh\nAQAB')).toBe('image/jpeg');
    expect(guessImageMime('UklGRgAAAABXRUJQ')).toBe('image/webp');
    expect(guessImageMime('UklGRgAAAABXRUJQ-_-_')).toBe('image/jpeg');
  });

  it('reads_synced_image_answer_after_file_id_deduplication', async () => {
    const f = await fixture();
    try {
      const imageBase64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      const local = await f.vfsRepo.attachments.uploadWithConn(f.db, f.blobsDir, {
        name: 'answer.gif', mimeType: 'image/gif', base64Content: imageBase64,
        type: 'image',
      });
      const sha256 = f.db.pluck<string>('SELECT sha256 FROM files WHERE id = ?1',
        [local.sourceId]);
      expect(sha256).toBeTruthy();

      const remoteId = 'file_remote_image_answer';
      const remoteName = 'answer-from-other-device.gif';
      f.db.exec(`CREATE TABLE IF NOT EXISTS __sync_id_aliases (
        table_name TEXT NOT NULL,
        remote_id TEXT NOT NULL,
        canonical_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (table_name, remote_id)
      )`);
      f.db.run(`INSERT INTO __sync_id_aliases (table_name, remote_id, canonical_id)
        VALUES ('files', ?1, ?2)`, [remoteId, local.sourceId]);
      // 同步应用后规范行采用远端文件名（内容按 sha256 去重到同一行）。
      f.db.run('UPDATE files SET name = ?1, file_name = ?1 WHERE id = ?2',
        [remoteName, local.sourceId]);
      expect(f.vfsRepo.attachments.getById(f.db, remoteId)).toBeNull();
      expect(f.vfsRepo.idAlias.resolvePersistedIdAlias(f.db, 'files', remoteId))
        .toBe(local.sourceId);
      const canonicalNames = f.db.one<{ name: string; file_name: string }>(
        'SELECT name, file_name FROM files WHERE id = ?1', [local.sourceId]);
      expect(canonicalNames).toEqual({ name: remoteName, file_name: remoteName });

      // 信封保留远端 ID；缩略图与评判两条读取路径都必须经别名解析。
      const envelope = JSON.stringify({
        type: 'image_answer',
        images: [{ id: remoteId, name: `${remoteId}.jpg`, mime: 'image/gif', hash: 'h-1' }],
        text: '',
      });
      const payload = parseImageAnswerEnvelope(envelope);
      expect(payload?.images[0]?.id).toBe(remoteId);
      expect(f.vfsRepo.attachments.getContent(f.db, f.blobsDir, remoteId))
        .toBe(imageBase64);
      expect(fetchImageAnswerContents(
        { db: f.db, blobsDir: f.blobsDir, vfsRepo: f.vfsRepo }, payload!))
        .toEqual([imageBase64]);
      expect(() => f.vfsRepo.attachments.getContentBounded(
        f.db, f.blobsDir, remoteId, 1)).toThrow();
      expect(f.vfsRepo.attachments.getContent(f.db, f.blobsDir, 'file_still_missing'))
        .toBeNull();
    } finally {
      await f.dispose();
    }
  });
});

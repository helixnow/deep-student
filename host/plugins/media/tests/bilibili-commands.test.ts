import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
// boundary-allow cross-plugin-impl: 测试用 L11 真实仓储解析内容来源；被测对象是本 lane 的命令
import { AttachmentRepo } from '../../vfs-repos/repository/attachments.ts';
// boundary-allow cross-plugin-impl: 同上
import { FileRepo } from '../../vfs-repos/repository/files.ts';
// boundary-allow cross-plugin-impl: 同上
import { MediaTranscriptRepo } from '../../vfs-repos/repository/media-transcripts.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';

function settings() {
  return { get: () => null, save: () => undefined };
}

function secrets() {
  const values = new Map<string, string>();
  return {
    openStore: () => ({
      getSecret: async (key: string) => values.get(key) ?? null,
      saveSecret: async (key: string, value: string) => { values.set(key, value); },
      deleteSecret: async (key: string) => { values.delete(key); },
    }),
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; }
  catch (error) { return error; }
  throw new Error('expected rejection');
}

it('media_bilibili_probe maps link parsing failures to the Rust error JSON', async () => {
  const host = await createTestHost({
    plugins: [media], provide: { storage: unusedStorage(), settings: settings(), secrets: secrets(), paths: { appDataDir: process.cwd() } },
  });
  try {
    const invalid = await rejection(host.invoke('media_bilibili_probe', { input: 'hello' }));
    expect(JSON.parse(invalid as string)).toEqual({
      code: 'bilibili-invalid-link',
      message: '没有认出 B 站视频链接：请粘贴视频页地址（含 BV 号）或 b23.tv 分享短链',
    });
    const unsupported = await rejection(host.invoke('media_bilibili_probe', {
      input: 'https://www.bilibili.com/bangumi/play/ep1',
    }));
    expect(JSON.parse(unsupported as string)).toEqual({
      code: 'bilibili-unsupported-link',
      message: '暂不支持番剧 / 影视、课堂、音频和直播链接，请粘贴普通视频的链接（含 BV 号）',
    });
  } finally { await host.dispose(); }
});

it('media_bilibili_create releases the single-create lock after a failed lookup', async () => {
  const host = await createTestHost({
    plugins: [media], provide: { storage: unusedStorage(), settings: settings(), secrets: secrets(), paths: { appDataDir: process.cwd() } },
  });
  try {
    for (let index = 0; index < 2; index += 1) {
      const error = await rejection(host.invoke('media_bilibili_create', { input: 'hello' }));
      expect(JSON.parse(error as string)).toMatchObject({
        code: 'bilibili-invalid-link',
      });
    }
  } finally { await host.dispose(); }
});

it('media_bilibili_stream_quality rejects stream paths that are not VFS file ids', async () => {
  const host = await createTestHost({
    plugins: [media], provide: { storage: unusedStorage(), settings: settings(), secrets: secrets(), paths: { appDataDir: process.cwd() } },
  });
  try {
    await expect(host.invoke('media_bilibili_stream_quality', { fileId: 'not-a-file' }))
      .rejects.toBe('无效的 B 站链接条目');
    await expect(host.invoke('media_bilibili_stream_quality', {
      fileId: 'res_0123456789abcdef',
    })).rejects.toBe('无效的 B 站链接条目');
  } finally { await host.dispose(); }
});

it('X2-D02 media_bilibili_stream_quality resolves the content source first (bilibili.rs:950-959)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-bili-stream-'));
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  try {
    const report = await storage.migrations.runAll();
    expect(report.success, report.error ?? '').toBe(true);
    const conn = storage.database('vfs');
    const host = await createTestHost({
      plugins: [media],
      provide: { storage: unusedStorage(),
        settings: settings(), secrets: secrets(), paths: { appDataDir: root },
        vfsDatabase: { getConnSafe: () => conn, blobsDir: () => path.join(root, 'vfs_blobs') },
        vfsRepo: { files: new FileRepo(), attachments: new AttachmentRepo(), mediaTranscripts: new MediaTranscriptRepo() },
      },
    });
    try {
      await expect(host.invoke('media_bilibili_stream_quality', { fileId: 'file_missing_x2' }))
        .rejects.toBe('媒体文件内容缺失: file_missing_x2');
    } finally { await host.dispose(); }
  } finally {
    storage.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

/**
 * 移动端 `dstu.media`（`mobile.ts`）装配与命令行为：
 * - 插件能装配（不触达 Node 专有模块，`original_path` / blob 路径无关）；
 * - 媒体库列表 / 进度 / 字幕视图走 `ctx.storage` + L11 仓储，与桌面同一实现；
 * - 链接条目封面在没有磁盘 blob 时是 `null`（不崩、不读文件）；
 * - 桌面独占命令返回 `UNSUPPORTED_ON_PLATFORM`，而不是 kernel 的 `not allowed by ACL`。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { UNSUPPORTED_ON_PLATFORM_PREFIX } from '../../../platform/errors/unsupported-on-platform.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
// boundary-allow cross-plugin-impl: 测试用 L11 真实仓储构造依赖；被测对象是本 lane 的命令
import { FileRepo } from '../../vfs-repos/repository/files.ts';
// boundary-allow cross-plugin-impl: 测试用 L11 真实仓储构造依赖；被测对象是本 lane 的命令
import { MediaTranscriptRepo } from '../../vfs-repos/repository/media-transcripts.ts';
import mobileMedia from '../mobile.ts';
import { unusedStorage } from './helpers/storage-double.ts';

let template: string;
let root: string;
let storage: ReturnType<typeof createStorageService>;
let conn: DatabaseHandle;
let database: VfsDatabase;
let repos: VfsReposService;
let host: TestHost;

function settings(values = new Map<string, string>()) {
  return {
    get: (key: string) => values.get(key) ?? null,
    save: (key: string, value: string) => { values.set(key, value); },
  };
}

beforeAll(async () => {
  template = fs.mkdtempSync(path.join(os.tmpdir(), 'media-mobile-schema-'));
  const source = createStorageService({ baseDir: template, dataLocalDir: template });
  try {
    const report = await source.migrations.runAll();
    expect(report.success, report.error ?? '').toBe(true);
  } finally { source.dispose(); }
}, 120_000);
afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-mobile-'));
  fs.cpSync(template, root, { recursive: true });
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  conn = storage.database('vfs');
  database = {
    getConnSafe: () => conn,
    blobsDir: () => path.join(root, 'vfs_blobs'),
  } as unknown as VfsDatabase;
  repos = {
    files: new FileRepo(),
    mediaTranscripts: new MediaTranscriptRepo(),
  } as unknown as VfsReposService;
  host = await createTestHost({
    plugins: [mobileMedia],
    // 与发布版移动端一致（握手 `debug: false`）：占位命令抛的是字符串，各命令契约的 error schema
    // 既有 `string` 也有 `AppError`，debug 模式的结果校验会把它们改写成 contract violation。
    app: { debug: false },
    provide: {
      storage: unusedStorage(),
      settings: settings(),
      vfsDatabase: database,
      vfsRepo: repos,
      paths: { appDataDir: root },
      notes: { repository: { getNoteContent: () => null } },
    },
  });
}, 60_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  fs.rmSync(root, { recursive: true, force: true });
}, 60_000);

function insertMediaFile(id: string, name: string, mime: string, fileType = 'audio'): void {
  conn.run(
    `INSERT INTO files (id, sha256, file_name, size, mime_type, type, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, 1000, ?4, ?5, 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    [id, `sha_${id}`, name, mime, fileType],
  );
}

it('installs the mobile media plugin with its declared commands', () => {
  const declared = new Set(mobileMedia.meta.commands ?? []);
  expect(mobileMedia.meta.platforms).toEqual(['mobile']);
  expect(declared.has('media_library_list')).toBe(true);
  expect(declared.has('media_bilibili_create')).toBe(true);
  expect(mobileMedia.meta.provides).toBeUndefined();
});

it('lists the media library through the portable data path', async () => {
  await expect(host.invoke('media_library_list', {})).resolves.toEqual([]);
  insertMediaFile('file_a', 'talk.mp3', 'audio/mpeg');
  insertMediaFile('file_v', 'lecture.mp4', 'video/mp4', 'video');
  insertMediaFile('file_pdf', 'book.pdf', 'application/pdf', 'document');
  const items = await host.invoke('media_library_list', {}) as { id: string; kind: string; coverUrl: string | null }[];
  expect(items.map(item => item.id).sort()).toEqual(['file_a', 'file_v']);
  expect(items.every(item => item.coverUrl === null)).toBe(true);
});

it('persists playback progress and reads the transcript view', async () => {
  insertMediaFile('file_a', 'talk.mp3', 'audio/mpeg');
  const saved = await host.invoke('media_progress_set', {
    resourceId: 'file_a', positionMs: 12_000, durationMs: 60_000, watchedDeltaMs: 5_000, finished: false,
  }) as { lastPositionMs: number; watchedMs: number };
  expect(saved.lastPositionMs).toBe(12_000);
  await expect(host.invoke('media_progress_get', { resourceId: 'file_a' }))
    .resolves.toMatchObject({ lastPositionMs: 12_000 });
  const view = await host.invoke('media_transcript_get', { resourceId: 'file_a' }) as { segments: unknown[] };
  expect(Array.isArray(view.segments)).toBe(true);
});

it('serves OCR settings from ctx.settings', async () => {
  await expect(host.invoke('get_ocr_engine_type', {})).resolves.toBe('paddle_ocr_vl');
  await expect(host.invoke('set_ocr_thinking_enabled', { enabled: true })).resolves.toBe(true);
  await expect(host.invoke('get_ocr_thinking_enabled', {})).resolves.toBe(true);
  const engines = await host.invoke('get_ocr_engines', {}) as unknown[];
  expect(Array.isArray(engines)).toBe(true);
});

it('has no disk blob paths on mobile', async () => {
  await expect(host.invoke('vfs_get_file_blob_path', { id: 'file_a' })).resolves.toBeNull();
});

it('answers UNSUPPORTED_ON_PLATFORM for desktop-only commands instead of an ACL error', async () => {
  for (const [name, args] of [
    ['media_bilibili_auth_status', {}],
    ['media_bilibili_create', { input: 'https://www.bilibili.com/video/BV1xx411c7mD' }],
    ['media_transcribe_start', { resourceId: 'file_a' }],
    ['tts_speak', { text: 'hello' }],
    ['parse_document_from_path', { filePath: '/tmp/a.pdf' }],
  ] as const) {
    const error = await host.invoke(name, args).catch((thrown: unknown) => thrown);
    expect(String(error)).toContain(UNSUPPORTED_ON_PLATFORM_PREFIX);
    expect(String(error)).toContain('is not available on mobile');
    expect(String(error)).not.toContain('not allowed by ACL');
  }
});

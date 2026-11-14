import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { HandlerPanic, createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { VfsError, type VfsDatabase } from '../../vfs/api.ts';
import type { VfsIndexService } from '../../vfs-index/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import { VfsRepositoryError } from '../../vfs-repos/api.ts';
// boundary-allow cross-plugin-impl: 测试用 L11 真实仓储构造依赖；被测对象是本 lane 的命令
import { BlobRepo } from '../../vfs-repos/repository/blobs.ts';
// boundary-allow cross-plugin-impl: 同上；files 仓储提供链接条目内容的真实读取行为
import { FileRepo } from '../../vfs-repos/repository/files.ts';
// boundary-allow cross-plugin-impl: 同上；mediaTranscripts 仓储提供字幕的导入/查询行为
import { MediaTranscriptRepo } from '../../vfs-repos/repository/media-transcripts.ts';
// boundary-allow cross-plugin-impl: 同上；textbooks 仓储提供 bookmarks 的真实写行为
import { TextbookRepo } from '../../vfs-repos/repository/textbooks.ts';
// boundary-allow cross-plugin-impl: 同上；attachments 仓储提供媒体内容解析的真实行为
import { AttachmentRepo } from '../../vfs-repos/repository/attachments.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';
import { MediaError, type BiliLinkDescriptor } from '../api.ts';
import { MediaError as ProductionMediaError } from '../src/errors.ts';
import { DESCRIPTOR_KIND, DESCRIPTOR_VERSION, descriptorToBytes, pageUrl } from '../src/bilibili-links.ts';
import {
  buildTranscriptView, exportTranscript, importSubtitle, loadMediaFile,
} from '../src/media-commands.ts';
import { autoTranscribeEligible, estimateImpl } from '../src/pipeline.ts';
import { MAX_SUBTITLE_BYTES } from '../src/subtitle.ts';
import { audio as nativeAudio } from '../../../platform/native/audio/index.ts';
import { lectureWav } from './helpers/wav-fixture.ts';
import { startServer } from './helpers/http-fixture.ts';

let template: string;
let root: string;
let storage: ReturnType<typeof createStorageService>;
let conn: DatabaseHandle;
let database: VfsDatabase;
let host: TestHost;
let repos: VfsReposService;
let noteContents: Map<string, string>;
let pdfRunning = false;
let startedFiles: string[] = [];

function settings(values = new Map<string, string>()) {
  return {
    get: (key: string) => values.get(key) ?? null,
    save: (key: string, value: string) => { values.set(key, value); },
  };
}

beforeAll(async () => {
  template = fs.mkdtempSync(path.join(os.tmpdir(), 'media-commands-schema-'));
  const source = createStorageService({ baseDir: template, dataLocalDir: template });
  try {
    const report = await source.migrations.runAll();
    expect(report.success, report.error ?? '').toBe(true);
  } finally { source.dispose(); }
}, 120_000);
afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-commands-'));
  fs.cpSync(template, root, { recursive: true });
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  conn = storage.database('vfs');
  database = {
    getConnSafe: () => conn,
    blobsDir: () => path.join(root, 'vfs_blobs'),
  } as unknown as VfsDatabase;
  noteContents = new Map();
  pdfRunning = false;
  startedFiles = [];
  repos = {
    files: new FileRepo(),
    mediaTranscripts: new MediaTranscriptRepo(),
    attachments: new AttachmentRepo(),
    textbooks: new TextbookRepo(),
  } as unknown as VfsReposService;
  host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(),
      settings: settings(),
      vfsDatabase: database,
      nativeAudio,
      paths: { appDataDir: root },
      'vfsRepo': repos,
      'vfsIndex': {
        pdf: {
          isRunning: () => pdfRunning,
          startPipeline: async (fileId: string) => {
            pdfRunning = true;
            startedFiles.push(fileId);
          },
          cancelMedia: () => {
            pdfRunning = false;
            return true;
          },
        },
      } as unknown as VfsIndexService,
      'notes': {
        repository: {
          getNoteContent: (id: string) => noteContents.get(id) ?? null,
        },
      },
    },
  });
}, 60_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  fs.rmSync(root, { recursive: true, force: true });
}, 60_000);

function insertFile(id: string, name: string, mime: string | null): void {
  conn.run(
    `INSERT INTO files (id, sha256, file_name, size, mime_type, type, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, 1000, ?4, 'audio', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    [id, `sha_${id}`, name, mime],
  );
}

function insertTextbook(id: string): void {
  conn.run(
    `INSERT INTO files (id, sha256, file_name, size, mime_type, type, status, created_at, updated_at)
     VALUES (?1, ?2, 'book.pdf', 1000, 'application/pdf', 'textbook', 'active',
             '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    [id, `sha_${id}`],
  );
}

function insertMediaFile(id: string, filePath: string): void {
  conn.run(
    `INSERT INTO files (id, sha256, file_name, original_path, size, mime_type, type, status,
                        created_at, updated_at)
     VALUES (?1, ?2, 'lecture.wav', ?3, 1000, 'audio/wav', 'audio', 'active',
             '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    [id, `sha_${id}`, filePath],
  );
}

it('import_get_export_flow', async () => {
  const wavPath = path.join(root, 'talk.wav');
  lectureWav(wavPath, [[1.0, true], [1.0, false]], 16_000);
  insertMediaFile('file_talk', wavPath);
  const info = loadMediaFile(conn, 'file_talk');
  expect(info).toMatchObject({ fileId: 'file_talk' });
  expect(buildTranscriptView(conn, repos.mediaTranscripts, info, false, true).status).toBe('none');

  expect(() => exportTranscript(conn, repos.mediaTranscripts, info, 'srt')).toThrow();

  const srt = '1\n00:00:00,500 --> 00:00:01,200\n第一句\n\n'
    + '2\n00:01:05,000 --> 00:01:07,000\n第二句\n';
  const count = importSubtitle(conn, repos.mediaTranscripts, repos.files, info, 'talk.srt', Buffer.from(srt, 'utf8'));
  expect(count).toBe(2);

  const view = buildTranscriptView(conn, repos.mediaTranscripts, info, false, true);
  expect(view.status).toBe('completed');
  expect(view.segments).toHaveLength(2);
  expect(view.progress.source).toBe('import');
  expect(view.progress.durationMs).toBe(67_000);
  expect(view.segments[1]!.startMs).toBe(65_000);
  expect(view.progress.completedSegments).toBe(2);

  const extracted = conn.get<{ extracted_text: string }>(
    "SELECT extracted_text FROM files WHERE id='file_talk'");
  expect(extracted?.extracted_text).toBe('[00:00] 第一句\n[01:05] 第二句');

  const vtt = exportTranscript(conn, repos.mediaTranscripts, info, 'vtt');
  expect(vtt.segments).toBe(2);
  expect(vtt.content).toContain('00:01:05.000 --> 00:01:07.000\n第二句');

  // 估算：已有计划 → 精确返回段数
  const [, planned, exact] = await estimateImpl(database, repos, info, nativeAudio);
  expect(planned).toBe(2);
  expect(exact).toBe(true);
});

it('estimate_decodes_short_media', async () => {
  const blobsDir = path.join(root, 'vfs_blobs');
  fs.mkdirSync(blobsDir, { recursive: true });
  const wavPath = path.join(blobsDir, 'short.wav');
  lectureWav(wavPath, [
    [0.5, false],
    [2.0, true],
    [2.0, false],
    [2.0, true],
  ], 22_050);
  insertMediaFile('file_short', wavPath);
  const info = loadMediaFile(conn, 'file_short');
  const [duration, planned, exact] = await estimateImpl(database, repos, info, nativeAudio);
  expect(duration).toBe(6_500);
  expect(planned).toBe(2);
  expect(exact).toBe(true);
});

it('publishes_media_transcriber_service', () => {
  expect(host.ctx.mediaTranscriber).toBeDefined();
  expect(typeof host.ctx.mediaTranscriber.transcribe).toBe('function');
});

// transcriber_hook.rs:143-153 / :126-140: real backend configuration failure → MediaError.
it('WP-204 public MediaError identifies the registered provider ASR configuration failure', async () => {
  expect(MediaError).toBe(ProductionMediaError);
  host.ctx.settings.getSecret = async () => null;
  const onProgress = vi.fn();
  const error: unknown = await host.ctx.mediaTranscriber.transcribe({
    fileId: 'file_unconfigured', tempDir: path.join(root, 'tmp', 'media'),
    imported: false, signal: new AbortController().signal, onProgress,
  }).catch((error: unknown) => error);

  expect(error).toBeInstanceOf(MediaError);
  if (!(error instanceof MediaError)) throw error;
  expect(error.code).toBe('settings-required');
  expect(error.message).toBe('未配置语音识别：请在「设置 → 模型分配」选择语音识别（ASR）模型，或填写 SiliconFlow API Key 使用默认模型');
  expect(error.toPayloadString()).toBe('{"code":"settings-required","message":"未配置语音识别：请在「设置 → 模型分配」选择语音识别（ASR）模型，或填写 SiliconFlow API Key 使用默认模型"}');
  expect(onProgress).not.toHaveBeenCalled();
});

// pipeline.rs cancellation → transcriber_hook.rs:127-132; no error mapping in the test.
it('WP-204 public MediaError preserves cancellation from the registered provider pipeline', async () => {
  host.ctx.settings.getSecret = async () => 'sk-test';
  insertMediaFile('file_cancel_public', path.join(root, 'cancel.wav'));
  const controller = new AbortController();
  const stages: string[] = [];
  const error: unknown = await host.ctx.mediaTranscriber.transcribe({
    fileId: 'file_cancel_public', tempDir: path.join(root, 'tmp', 'media'),
    imported: false, signal: controller.signal,
    onProgress: update => { stages.push(update.stage); controller.abort(); },
  }).catch((error: unknown) => error);

  expect(error).toBeInstanceOf(MediaError);
  if (!(error instanceof MediaError)) throw error;
  expect(error.code).toBe('cancelled');
  expect(error.message).toBe('已取消');
  expect(error.toPayloadString()).toBe('{"code":"cancelled","message":"已取消"}');
  expect(stages).toEqual(['queued']);
});

it('mediaTranscriber service writes imported subtitles without ASR', async () => {
  insertMediaFile('file_service', path.join(root, 'service.wav'));
  repos.mediaTranscripts.setImportedSegments(conn, 'file_service', [
    [{ startMs: 0, endMs: 1_000 }, '导入字幕'],
  ]);

  const result = await host.ctx.mediaTranscriber.transcribe({
    fileId: 'file_service',
    tempDir: path.join(root, 'tmp', 'media'),
    imported: true,
    signal: new AbortController().signal,
    onProgress: () => undefined,
  });
  expect(result.transcriptChars).toBeGreaterThan(0);
  expect(result).toMatchObject({ doneSegments: 1, totalSegments: 1, failedSegments: 0 });
  const extracted = conn.get<{ extracted_text: string }>(
    'SELECT extracted_text FROM files WHERE id = ?1', ['file_service']);
  expect(extracted?.extracted_text).toBe('[00:00] 导入字幕');
});

it('media_transcribe_start schedules imported plans without ASR and returns the running view', async () => {
  insertMediaFile('file_start', path.join(root, 'start.wav'));
  repos.mediaTranscripts.setImportedSegments(conn, 'file_start', [
    [{ startMs: 0, endMs: 1_000 }, '导入字幕'],
  ]);
  conn.run('UPDATE media_transcript_segments SET status = 0 WHERE resource_id = ?1',
    ['file_start']);

  const view = await host.invoke('media_transcribe_start', {
    resourceId: 'file_start',
  }) as {
    resourceId: string; status: string;
    progress: { source: string | null; completedSegments: number; totalSegments: number };
    segments?: unknown;
  };
  expect(startedFiles).toEqual(['file_start']);
  expect(view).toMatchObject({
    resourceId: 'file_start',
    status: 'queued',
    progress: { source: 'import', completedSegments: 0, totalSegments: 1 },
  });
  expect(view.segments).toBeUndefined();

  await host.invoke('media_transcribe_start', { resourceId: 'file_start' });
  expect(startedFiles).toEqual(['file_start']);
});

it('media_transcribe_estimate command reports ASR state and exact decoding', async () => {
  const blobsDir = path.join(root, 'vfs_blobs');
  fs.mkdirSync(blobsDir, { recursive: true });
  const wavPath = path.join(blobsDir, 'memo.wav');
  lectureWav(wavPath, [[1.0, true]], 16_000);
  insertMediaFile('file_memo', wavPath);
  const estimate = await host.invoke('media_transcribe_estimate', {
    resourceId: 'file_memo',
  }) as {
    durationMs: number | null; plannedSegments: number | null; asrModel: string;
    asrConfigured: boolean; exact: boolean;
  };
  expect(estimate.durationMs).toBe(1_000);
  expect(estimate.plannedSegments).toBe(1);
  expect(estimate.exact).toBe(true);
  expect(estimate.asrConfigured).toBe(false);
  expect(estimate.asrModel).toBe('Qwen/Qwen3-ASR-1.7B');
});

it('non_media_files_are_rejected', () => {
  insertFile('file_pdf', 'a.pdf', 'application/pdf');
  expect(() => loadMediaFile(conn, 'file_pdf')).toThrowError('不是音视频文件');
  try {
    loadMediaFile(conn, 'file_pdf');
  } catch (error) {
    expect((error as { code?: string }).code).toBe('invalid-input');
  }
  try {
    loadMediaFile(conn, 'file_nope');
  } catch (error) {
    expect((error as { code?: string }).code).toBe('not-found');
  }
});

it('media_progress_get and media_progress_set round-trip via the command layer', async () => {
  insertFile('file_talk', 'talk.mp3', 'audio/mpeg');
  expect(await host.invoke('media_progress_get', { resourceId: 'file_talk' })).toBeNull();

  const first = await host.invoke('media_progress_set', {
    resourceId: 'file_talk', positionMs: 30_000, durationMs: 60_000, watchedDeltaMs: 20_000,
  });
  expect(first).toMatchObject({
    resourceId: 'file_talk', lastPositionMs: 30_000, durationMs: 60_000,
    watchedMs: 20_000, finished: false,
  });
  expect((first as { updatedAt: number }).updatedAt).toBeGreaterThan(0);

  const second = await host.invoke('media_progress_set', {
    resourceId: 'file_talk', positionMs: 59_000, finished: null,
  });
  expect(second).toMatchObject({
    lastPositionMs: 59_000, durationMs: 60_000, watchedMs: 20_000, finished: true,
  });
  expect(await host.invoke('media_progress_get', { resourceId: 'file_talk' })).toEqual(second);

  await host.invoke('media_progress_set', { resourceId: 'file_talk', finished: false });
  expect((await host.invoke('media_progress_get', { resourceId: 'file_talk' }) as {
    finished: boolean;
  }).finished).toBe(false);
});

it('D1-L18-M03 media_progress_get/set map each database step to database-failed (commands.rs:533-566)', async () => {
  insertFile('file_talk', 'talk.mp3', 'audio/mpeg');
  const dbFailed = (message: string) => JSON.stringify({ code: 'database-failed', message });
  const getConnSafe = database.getConnSafe;

  // pipeline.rs:115 / commands.rs:540,555 `get_conn_safe()` → VfsError → MediaError::Database(Display)
  database.getConnSafe = () => { throw new VfsError('Maintenance', { component: 'vfs' }); };
  await expect(host.invoke('media_progress_get', { resourceId: 'file_talk' }))
    .rejects.toBe(dbFailed('MAINTENANCE_MODE: vfs is temporarily unavailable'));
  database.getConnSafe = () => { throw new VfsError('Pool', 'Failed to get connection: timed out'); };
  await expect(host.invoke('media_progress_set', { resourceId: 'file_talk', positionMs: 1 }))
    .rejects.toBe(dbFailed('Connection pool error: Failed to get connection: timed out'));
  database.getConnSafe = getConnSafe;

  // set_progress_with_conn write failure → VfsError::Database("Database error: <sqlite msg>")
  await host.invoke('media_progress_set', { resourceId: 'file_talk', positionMs: 1_000, watchedDeltaMs: 500 });
  const before = await host.invoke('media_progress_get', { resourceId: 'file_talk' });
  conn.exec(`CREATE TRIGGER block_progress BEFORE INSERT ON media_progress
    BEGIN SELECT RAISE(ABORT, 'progress write blocked'); END`);
  await expect(host.invoke('media_progress_set', { resourceId: 'file_talk', positionMs: 2_000 }))
    .rejects.toBe(dbFailed('Database error: progress write blocked'));
  conn.exec('DROP TRIGGER block_progress');
  expect(await host.invoke('media_progress_get', { resourceId: 'file_talk' })).toEqual(before);

  // get_progress_with_conn column decode failure (row.get::<i64>) → VfsError::Database
  conn.run("UPDATE media_progress SET last_position_ms = 'abc' WHERE resource_id = ?1", ['file_talk']);
  const invalidColumn = dbFailed(
    'Database error: Invalid column type Text at index: 1, name: last_position_ms');
  await expect(host.invoke('media_progress_get', { resourceId: 'file_talk' })).rejects.toBe(invalidColumn);
  await expect(host.invoke('media_progress_set', { resourceId: 'file_talk', positionMs: 3 }))
    .rejects.toBe(invalidColumn);
  // load runs first: a missing file is still NotFound even while progress reads would fail
  await expect(host.invoke('media_progress_get', { resourceId: 'file_missing' }))
    .rejects.toBe(JSON.stringify({ code: 'not-found', message: '媒体文件不存在: file_missing' }));

  // get_progress_with_conn SQL failure
  conn.exec('DROP TABLE media_progress');
  await expect(host.invoke('media_progress_get', { resourceId: 'file_talk' }))
    .rejects.toBe(dbFailed('Database error: no such table: media_progress'));

  // pipeline.rs:116-136 load_media_file query failure other than NoRows → MediaError::Database(rusqlite msg)
  conn.exec('ALTER TABLE files RENAME TO files_moved');
  await expect(host.invoke('media_progress_get', { resourceId: 'file_talk' }))
    .rejects.toBe(dbFailed('no such table: files'));
  await expect(host.invoke('media_progress_set', { resourceId: 'file_talk', positionMs: 1 }))
    .rejects.toBe(dbFailed('no such table: files'));
});

it('D1-L18-M03 media_progress keeps unknown program errors as panics', async () => {
  insertFile('file_talk', 'talk.mp3', 'audio/mpeg');
  const getProgress = vi.spyOn(repos.mediaTranscripts, 'getProgress')
    .mockImplementation(() => { throw new TypeError('progress bug'); });
  const getError = await host.invoke('media_progress_get', { resourceId: 'file_talk' })
    .catch((error: unknown) => error);
  expect(getError).toBeInstanceOf(HandlerPanic);
  expect((getError as HandlerPanic).cause).toBeInstanceOf(TypeError);
  getProgress.mockRestore();

  vi.spyOn(repos.mediaTranscripts, 'setProgress')
    .mockImplementation(() => { throw new RangeError('progress bug'); });
  const setError = await host.invoke('media_progress_set', { resourceId: 'file_talk', positionMs: 1 })
    .catch((error: unknown) => error);
  expect(setError).toBeInstanceOf(HandlerPanic);
  expect((setError as HandlerPanic).cause).toBeInstanceOf(RangeError);

  database.getConnSafe = () => { throw new Error('connection bug'); };
  const connError = await host.invoke('media_progress_get', { resourceId: 'file_talk' })
    .catch((error: unknown) => error);
  expect(connError).toBeInstanceOf(HandlerPanic);
});

it('media_transcribe_cancel returns a status view without segments', async () => {
  insertFile('file_cancel', 'talk.mp3', 'audio/mpeg');
  const view = await host.invoke('media_transcribe_cancel', {
    resourceId: 'file_cancel',
  }) as { resourceId: string; status: string; progress: { totalSegments: number }; segments?: unknown };
  expect(view.resourceId).toBe('file_cancel');
  expect(view.status).toBe('none');
  expect(view.progress.totalSegments).toBe(0);
  expect(view.segments).toBeUndefined();
});

it('L18-M01 media_transcript_get snapshots scheduler running state (commands.rs:390)', async () => {
  insertFile('file_running', 'talk.mp3', 'audio/mpeg');
  pdfRunning = true;
  await expect(host.invoke('media_transcript_get', { resourceId: 'file_running' }))
    .resolves.toMatchObject({ status: 'queued', segments: [] });
  conn.run('UPDATE files SET processing_status = ?1 WHERE id = ?2', ['asr', 'file_running']);
  await expect(host.invoke('media_transcript_get', { resourceId: 'file_running' }))
    .resolves.toMatchObject({ status: 'running' });
  pdfRunning = false;
  await expect(host.invoke('media_transcript_get', { resourceId: 'file_running' }))
    .resolves.toMatchObject({ status: 'none' });
});

it('L18-M01 cancellation failure is a wire database error and stops import before writes', async () => {
  insertFile('file_cancel_error', 'talk.mp3', 'audio/mpeg');
  repos.mediaTranscripts.setImportedSegments(conn, 'file_cancel_error', [
    [{ startMs: 0, endMs: 1000 }, 'original'],
  ]);
  const cancel = vi.spyOn(host.ctx.vfsIndex.pdf, 'cancelMedia').mockImplementation(() => {
    throw new Error('cancel database failure');
  });
  const expected = JSON.stringify({ code: 'database-failed', message: 'cancel database failure' });
  await expect(host.invoke('media_transcribe_cancel', { resourceId: 'file_cancel_error' }))
    .rejects.toBe(expected);
  pdfRunning = true;
  const srtPath = path.join(root, 'replacement.srt');
  fs.writeFileSync(srtPath, '1\n00:00:00,000 --> 00:00:01,000\nreplacement\n');
  await expect(host.invoke('media_transcript_import', {
    resourceId: 'file_cancel_error', path: srtPath,
  })).rejects.toBe(expected);
  expect(repos.mediaTranscripts.listSegments(conn, 'file_cancel_error')[0]?.text).toBe('original');
  expect(startedFiles).toEqual([]);
  cancel.mockRestore();
});

it('L18-M01 file-read errors precede cancellation, as commands.rs:433-437', async () => {
  insertFile('file_read_error', 'talk.mp3', 'audio/mpeg');
  pdfRunning = true;
  const cancel = vi.spyOn(host.ctx.vfsIndex.pdf, 'cancelMedia');
  await expect(host.invoke('media_transcript_import', {
    resourceId: 'file_read_error', path: path.join(root, 'absent.srt'),
  })).rejects.toContain('io-failed');
  expect(cancel).not.toHaveBeenCalled();
  expect(pdfRunning).toBe(true);
  cancel.mockRestore();
});

it('L18-M01 transcript progress parses JSON Value and casts f64 to f32', async () => {
  insertFile('file_percent', 'talk.mp3', 'audio/mpeg');
  for (const [raw, expected] of [
    ['{"percent":0.1}', Math.fround(0.1)],
    ['null', 0], ['[]', 0], ['{"percent":"12"}', 0], ['{', 0],
  ] as const) {
    conn.run('UPDATE files SET processing_progress = ?1 WHERE id = ?2', [raw, 'file_percent']);
    await expect(host.invoke('media_transcript_get', { resourceId: 'file_percent' }))
      .resolves.toMatchObject({ progress: { percent: expected } });
  }
});

it('media_transcript_get reports imported segments and media_transcript_export writes srt', async () => {
  insertFile('file_talk', 'talk.mp3', 'audio/mpeg');
  expect(await host.invoke('media_transcript_get', { resourceId: 'file_talk' })).toMatchObject({
    resourceId: 'file_talk', mediaType: 'audio', status: 'none', segments: [],
  });
  const repo = new MediaTranscriptRepo();
  repo.setImportedSegments(conn, 'file_talk', [
    [{ startMs: 500, endMs: 1_200 }, '第一句'],
    [{ startMs: 65_000, endMs: 67_000 }, '第二句'],
  ]);

  const view = await host.invoke('media_transcript_get', { resourceId: 'file_talk' }) as {
    status: string;
    segments: Array<{ idx: number; startMs: number; endMs: number; text: string; status: number }>;
    progress: { source: string | null; completedSegments: number; totalSegments: number; percent: number };
  };
  expect(view.status).toBe('completed');
  expect(view.segments).toEqual([
    { idx: 0, startMs: 500, endMs: 1_200, text: '第一句', status: 1 },
    { idx: 1, startMs: 65_000, endMs: 67_000, text: '第二句', status: 1 },
  ]);
  expect(view.progress.source).toBe('import');
  expect(view.progress.completedSegments).toBe(2);
  expect(view.progress.percent).toBe(100);

  const dest = path.join(root, 'talk.srt');
  const exported = await host.invoke('media_transcript_export', {
    resourceId: 'file_talk', format: '.SRT', dest,
  });
  expect(exported).toMatchObject({ path: dest, format: 'srt', segments: 2 });
  const text = fs.readFileSync(dest, 'utf8');
  expect(text).toContain('00:00:00,500 --> 00:00:01,200\n第一句');
  expect(text).toContain('00:01:05,000 --> 00:01:07,000\n第二句');
  expect((exported as { bytes: number }).bytes).toBe(Buffer.byteLength(text, 'utf8'));
});

it('media_transcript_export rejects formats and empty transcripts', async () => {
  insertFile('file_talk', 'talk.mp3', 'audio/mpeg');
  await expect(host.invoke('media_transcript_export', {
    resourceId: 'file_talk', format: 'srt', dest: path.join(root, 'x.srt'),
  })).rejects.toThrow('还没有可导出的字幕');
  const repo = new MediaTranscriptRepo();
  repo.setImportedSegments(conn, 'file_talk', [[{ startMs: 0, endMs: 100 }, 'hi']]);
  await expect(host.invoke('media_transcript_export', {
    resourceId: 'file_talk', format: 'docx', dest: path.join(root, 'x.docx'),
  })).rejects.toThrow('不支持的导出格式: docx');
});

it('media_transcript_import replaces segments and writes extracted_text', async () => {
  insertFile('file_import', 'lecture.mp3', 'audio/mpeg');
  const srtPath = path.join(root, 'lecture.srt');
  fs.writeFileSync(srtPath,
    '1\n00:00:00,500 --> 00:00:01,200\n第一句\n\n'
    + '2\n00:01:05,000 --> 00:01:07,000\n第二句\n', 'utf8');

  const view = await host.invoke('media_transcript_import', {
    resourceId: 'file_import', path: srtPath,
  }) as {
    status: string;
    segments: Array<{ startMs: number; endMs: number; text: string }>;
    progress: { source: string | null; durationMs: number | null; completedSegments: number };
  };
  // commands.rs:470-478 starts indexing and reads its current running state.
  expect(view.status).toBe('queued');
  expect(startedFiles).toEqual(['file_import']);
  expect(view.segments).toHaveLength(2);
  expect(view.segments[1]!.startMs).toBe(65_000);
  expect(view.progress.source).toBe('import');
  expect(view.progress.durationMs).toBe(67_000);
  expect(view.progress.completedSegments).toBe(2);

  const extracted = conn.get<{ extracted_text: string }>(
    "SELECT extracted_text FROM files WHERE id='file_import'");
  expect(extracted?.extracted_text).toBe('[00:00] 第一句\n[01:05] 第二句');

  expect(await host.invoke('media_transcript_export', {
    resourceId: 'file_import', format: 'vtt', dest: path.join(root, 'out.vtt'),
  })).toMatchObject({ segments: 2, format: 'vtt' });
});

it('L18-M01 import keeps committed subtitles and warns when scheduling fails', async () => {
  insertFile('file_schedule_error', 'talk.mp3', 'audio/mpeg');
  const srtPath = path.join(root, 'schedule.srt');
  fs.writeFileSync(srtPath, '1\n00:00:00,000 --> 00:00:01,000\nretained\n');
  const order: string[] = [];
  const warnings: unknown[][] = [];
  const stopLogging = host.ctx.logger.exporter({
    levels: { default: 3 },
    export(message) {
      if (message.name !== 'media.commands') return;
      order.push(message.type);
      if (message.type === 'warn') warnings.push(message.args);
    },
  });
  const start = vi.spyOn(host.ctx.vfsIndex.pdf, 'startPipeline').mockImplementation(async fileId => {
    order.push('start');
    expect(conn.pluck('SELECT extracted_text FROM files WHERE id = ?1', [fileId])).toBe('[00:00] retained');
    throw new Error('index scheduler failed');
  });
  try {
    await expect(host.invoke('media_transcript_import', {
      resourceId: 'file_schedule_error', path: srtPath,
    })).resolves.toMatchObject({ status: 'completed', segments: [{ text: 'retained' }] });
    expect(order).toEqual(['info', 'start', 'warn']);
    expect(warnings).toEqual([[
      '[media::commands] failed to schedule indexing for %s: %s',
      'file_schedule_error', 'index scheduler failed']]);
  } finally { start.mockRestore(); stopLogging(); }
});

it('media_transcript_import prefers L13 mediaIndex transcript refresh', async () => {
  insertFile('file_l13', 'lecture.mp3', 'audio/mpeg');
  const srtPath = path.join(root, 'l13.srt');
  fs.writeFileSync(srtPath,
    '1\n00:00:00,500 --> 00:00:01,200\n第一句\n', 'utf8');
  const calls: unknown[][] = [];
  const l13 = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(),
      settings: settings(),
      vfsDatabase: database,
      vfsRepo: repos,
      paths: { appDataDir: root },
      vfs: {
        version: 1,
        database,
        unitIndex: { kind: 'unit-index' },
        mediaIndex: {
          refreshTranscriptIndex: (...args: unknown[]) => { calls.push(args); return 1; },
        },
      },
    },
  });
  try {
    await l13.invoke('media_transcript_import', {
      resourceId: 'file_l13', path: srtPath,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(database);
    expect(calls[0]![1]).toEqual({ kind: 'unit-index' });
    expect(calls[0]![2]).toBe('file_l13');
  } finally { await l13.dispose(); }
});

it('media_chapters uses the first related handout with anchors', async () => {
  insertFile('file_lec', 'lecture.mp3', 'audio/mpeg');
  const insertNote = (id: string, origin: unknown, content: string, updatedAt: string): void => {
    conn.run(
      `INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
       VALUES (?1, ?2, 'note', 'inline', '', 0, 1, 1)`,
      [`res_${id}`, `hash_${id}`],
    );
    conn.run(
      `INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at, deleted_at, props)
       VALUES (?1, ?2, ?3, '[]', 0, ?4, ?4, NULL, ?5)`,
      [id, `res_${id}`, id, updatedAt,
        JSON.stringify({ _origin: JSON.stringify(origin) })],
    );
    noteContents.set(id, content);
  };
  insertNote('note_old', { kind: 'resource', resourceId: 'file_lec' }, '没有标题', '2026-01-01T00:00:00Z');
  insertNote('note_new', { kind: 'resource', resourceId: 'file_lec' },
    '# 讲义\n\n## 二、正则化 [媒体@file_lec:12:30]\n\n## 一、过拟合\n\n[媒体@file_lec:00:30]\n\n'
    + '## 三、重复\n\n[媒体@file_lec:00:30]', '2026-02-01T00:00:00Z');

  expect(await host.invoke('media_chapters', { resourceId: 'file_lec' })).toEqual([
    { title: '一、过拟合', seconds: 30 },
    { title: '二、正则化', seconds: 750 },
  ]);
  expect(await host.invoke('media_chapters', { resourceId: '   ' })).toEqual([]);
});

it('textbooks_update_bookmarks persists the array and refreshes updated_at', async () => {
  insertTextbook('tb_1');
  const bookmarks = [{ page: 3, label: '重点' }, { page: 9, label: '复习' }];
  expect(await host.invoke('textbooks_update_bookmarks', {
    id: 'tb_1', bookmarks,
  })).toBe(true);
  const row = conn.get<{ bookmarks_json: string; updated_at: string }>(
    "SELECT bookmarks_json, updated_at FROM files WHERE id = 'tb_1'",
  )!;
  expect(JSON.parse(row.bookmarks_json)).toEqual(bookmarks);
  expect(row.updated_at).not.toBe('2026-01-01T00:00:00Z');
});

function insertRelinkTextbook(id: string, fileName: string, sha256: string): void {
  conn.run(
    `INSERT INTO files (id, sha256, file_name, size, mime_type, type, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, 16, 'application/pdf', 'textbook', 'active',
             '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    [id, sha256, fileName],
  );
}

it('textbooks_relink verifies the content hash and heals the missing blob', async () => {
  const bytes = Buffer.from('%PDF-1.7 relink');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const firstPath = path.join(root, 'Reference.PDF');
  fs.writeFileSync(firstPath, bytes);
  insertRelinkTextbook('tb_relink', 'Reference.PDF', sha256);

  const result = await host.invoke('textbooks_relink', {
    id: 'tb_relink', newPath: firstPath,
  }) as { updated_at: string };
  expect(result).toMatchObject({
    id: 'tb_relink', sha256, file_name: 'Reference.PDF', file_path: firstPath,
    status: 'active', favorite: 0, tags_json: '[]', bookmarks_json: '[]', origin_json: null,
  });
  expect(result.updated_at).not.toBe('2026-01-01T00:00:00Z');

  const row = conn.get<{ original_path: string; blob_hash: string }>(
    "SELECT original_path, blob_hash FROM files WHERE id = 'tb_relink'",
  )!;
  expect(row.original_path).toBe(firstPath);
  expect(row.blob_hash).toMatch(/^[0-9a-f]{64}$/);
  const blob = conn.get<{ relative_path: string }>(
    'SELECT relative_path FROM blobs WHERE hash = ?1', [row.blob_hash],
  )!;
  expect(blob.relative_path.endsWith('.pdf')).toBe(true);
  expect(fs.readFileSync(path.join(root, 'vfs_blobs', blob.relative_path))).toEqual(bytes);
  expect(host.events.map((event) => [event.event, event.payload])).toEqual([
    ['dstu:change:/tb_relink', { type: 'updated', path: '/tb_relink' }],
    ['dstu:change', { type: 'updated', path: '/tb_relink' }],
  ]);
  // V03-05: textbooks.rs:70,76 `Window::emit` broadcasts in Tauri 2.
  expect(host.events.map((event) => event.target)).toEqual([{ kind: 'Any' }, { kind: 'Any' }]);

  // 已存在的 blob 不会被重复补存，但 original_path 会更新到新位置。
  const secondPath = path.join(root, 'Reference-copy.PDF');
  fs.writeFileSync(secondPath, bytes);
  await host.invoke('textbooks_relink', { id: 'tb_relink', newPath: secondPath });
  const again = conn.get<{ original_path: string; blob_hash: string }>(
    "SELECT original_path, blob_hash FROM files WHERE id = 'tb_relink'",
  )!;
  expect(again).toEqual({ original_path: secondPath, blob_hash: row.blob_hash });
  expect(conn.pluck<number>('SELECT COUNT(*) FROM blobs WHERE hash = ?1', [row.blob_hash])).toBe(1);
});

it('textbooks_relink rejects a different file without touching the record', async () => {
  const filePath = path.join(root, 'other.pdf');
  fs.writeFileSync(filePath, '%PDF-1.7 other');
  insertRelinkTextbook('tb_other', 'Reference.PDF', 'a'.repeat(64));
  await expect(host.invoke('textbooks_relink', {
    id: 'tb_other', newPath: filePath,
  })).rejects.toEqual({
    error_type: 'Validation',
    message: '所选文件与原文件内容不一致，请选择同一个文件',
    details: null,
  });
  expect(conn.get(
    "SELECT original_path, blob_hash FROM files WHERE id = 'tb_other'",
  )).toEqual({ original_path: null, blob_hash: null });
  expect(host.events).toEqual([]);
});

it('textbooks_relink reports missing textbooks and unreadable files', async () => {
  await expect(host.invoke('textbooks_relink', {
    id: 'tb_missing', newPath: path.join(root, 'nowhere.pdf'),
  })).rejects.toEqual({
    error_type: 'NotFound', message: '教材不存在: tb_missing', details: null,
  });

  insertRelinkTextbook('tb_unreadable', 'Reference.PDF', 'b'.repeat(64));
  await expect(host.invoke('textbooks_relink', {
    id: 'tb_unreadable', newPath: path.join(root, 'nowhere.pdf'),
  })).rejects.toMatchObject({
    error_type: 'FileSystem',
    message: expect.stringMatching(/^读取文件失败: .*nowhere\.pdf/),
  });
  expect(conn.pluck<string>(
    "SELECT original_path FROM files WHERE id = 'tb_unreadable'",
  )).toBeNull();
});

// src/cmd/textbooks.rs:741-753：now 按 %Y-%m-%dT%H:%M:%S%.3fZ 生成，UPDATE 只改 original_path/updated_at，自动提交。
it('textbooks_relink writes original_path through the textbooks owner with a millisecond Z timestamp', async () => {
  const bytes = Buffer.from('%PDF-1.7 owner');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const filePath = path.join(root, 'Owner.pdf');
  fs.writeFileSync(filePath, bytes);
  insertRelinkTextbook('tb_owner', 'Owner.pdf', sha256);
  // 第一次 relink 补存 blob；之后 attach_blob_if_missing 为 no-op，第二次只剩 owner UPDATE。
  await host.invoke('textbooks_relink', { id: 'tb_owner', newPath: filePath });
  const before = conn.get<Record<string, unknown>>("SELECT * FROM files WHERE id = 'tb_owner'")!;
  const movedPath = path.join(root, 'Owner-moved.pdf');
  fs.writeFileSync(movedPath, bytes);

  await host.invoke('textbooks_relink', { id: 'tb_owner', newPath: movedPath });

  const after = conn.get<Record<string, unknown>>("SELECT * FROM files WHERE id = 'tb_owner'")!;
  expect(after.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(after).toEqual({ ...before, original_path: movedPath, updated_at: after.updated_at });
});

// textbooks.rs:749-753：UPDATE 失败包成 AppError::database("更新 original_path 失败: {e}")，不发事件。
it('textbooks_relink wraps the owner SQL error and leaves the textbook unchanged', async () => {
  const bytes = Buffer.from('%PDF-1.7 rejected');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const filePath = path.join(root, 'Rejected.pdf');
  fs.writeFileSync(filePath, bytes);
  insertRelinkTextbook('tb_reject', 'Rejected.pdf', sha256);
  conn.exec(`CREATE TRIGGER reject_relink BEFORE UPDATE OF original_path ON files
    BEGIN SELECT RAISE(ABORT, 'original_path rejected'); END;`);
  const before = conn.get("SELECT * FROM files WHERE id = 'tb_reject'");

  await expect(host.invoke('textbooks_relink', { id: 'tb_reject', newPath: filePath }))
    .rejects.toEqual({
      error_type: 'Database', message: '更新 original_path 失败: original_path rejected', details: null,
    });
  expect(conn.get("SELECT * FROM files WHERE id = 'tb_reject'")).toEqual(before);
  expect(host.events).toEqual([]);
});

// textbooks.rs:741-768 无事务：original_path 已自动提交，随后补存 blob 失败不会回滚它。
it('textbooks_relink keeps the committed original_path when the later blob attach fails', async () => {
  const bytes = Buffer.from('%PDF-1.7 attach');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const filePath = path.join(root, 'Attach.pdf');
  fs.writeFileSync(filePath, bytes);
  insertRelinkTextbook('tb_attach', 'Attach.pdf', sha256);
  conn.exec(`CREATE TRIGGER reject_blob_attach BEFORE UPDATE OF blob_hash ON files
    BEGIN SELECT RAISE(ABORT, 'blob_hash rejected'); END;`);

  await expect(host.invoke('textbooks_relink', { id: 'tb_attach', newPath: filePath }))
    .rejects.toMatchObject({
      error_type: 'Database', message: expect.stringMatching(/^补存 blob 失败: /),
    });
  expect(conn.get("SELECT original_path, blob_hash FROM files WHERE id = 'tb_attach'"))
    .toEqual({ original_path: filePath, blob_hash: null });
  expect(host.events).toEqual([]);
});

// commands.rs:404-419：段在前一连接自动提交，write_transcript_text 失败经 `?` 上抛，不回滚已导入段。
it('import_subtitle keeps committed segments when the files owner rejects extracted_text', () => {
  const wavPath = path.join(root, 'reject.wav');
  lectureWav(wavPath, [[1.0, true]], 16_000);
  insertMediaFile('file_reject', wavPath);
  const info = loadMediaFile(conn, 'file_reject');
  conn.exec(`CREATE TRIGGER reject_import_text BEFORE UPDATE OF extracted_text ON files
    BEGIN SELECT RAISE(ABORT, 'extracted_text rejected'); END;`);
  const before = conn.get<Record<string, unknown>>("SELECT * FROM files WHERE id = 'file_reject'")!;

  expect(() => importSubtitle(conn, repos.mediaTranscripts, repos.files, info, 'r.srt',
    Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nkept\n', 'utf8'))).toThrow('extracted_text rejected');
  expect(repos.mediaTranscripts.listSegments(conn, 'file_reject').map(segment => segment.text))
    .toEqual(['kept']);
  expect(conn.get("SELECT * FROM files WHERE id = 'file_reject'")).toEqual(before);
});

it('auto_transcribe_only_for_short_untranscribed_audio', async () => {
  const blobsDir = path.join(root, 'vfs_blobs');
  fs.mkdirSync(blobsDir, { recursive: true });
  const wavPath = path.join(blobsDir, 'memo.wav');
  lectureWav(wavPath, [[1.0, true]], 16_000);
  insertMediaFile('file_memo', wavPath);
  expect(await autoTranscribeEligible(
    database, repos, loadMediaFile(conn, 'file_memo'), nativeAudio)).toBe(true);

  const info = loadMediaFile(conn, 'file_memo');
  importSubtitle(conn, repos.mediaTranscripts, repos.files, info, 'm.srt',
    Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nhi\n', 'utf8'));
  expect(await autoTranscribeEligible(
    database, repos, loadMediaFile(conn, 'file_memo'), nativeAudio)).toBe(false);
});

it('repository_persists_highlights_and_rejects_stale_version', () => {
  const textbook = repos.textbooks.createTextbook(
    conn, 'annotations-hash', 'book.pdf', 1, null, null);
  const highlight = {
    id: 'hl-1', pageIndex: 0, text: 'hello', color: '#fef08a',
    rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.1 }],
    createdAt: 1, coordVersion: 2,
  };
  const updated = repos.textbooks.replaceHighlightsIfVersion(
    conn, textbook.id, [highlight], textbook.updatedAt);
  expect(updated.highlights).toEqual([highlight]);

  let stale: unknown;
  try {
    repos.textbooks.replaceHighlightsIfVersion(
      conn, textbook.id, [highlight], textbook.updatedAt);
  } catch (error) { stale = error; }
  expect(stale).toBeInstanceOf(VfsRepositoryError);
  expect((stale as VfsRepositoryError).code).toBe('VFS_CONFLICT');
});

function linkDescriptor(): BiliLinkDescriptor {
  return {
    kind: DESCRIPTOR_KIND,
    version: DESCRIPTOR_VERSION,
    bvid: 'BV1GJ411x7h7',
    aid: 80_433_022,
    cid: 137_649_199,
    page: 1,
    pageCount: 1,
    title: '线性代数 第1讲',
    part: '',
    owner: 'UP',
    cover: 'http://i0.hdslb.com/bfs/archive/a.jpg',
    durationMs: 213_000,
    url: pageUrl('BV1GJ411x7h7', 1),
  };
}

it('media_bilibili_link_get reads and validates a blob-backed descriptor', async () => {
  const bytes = descriptorToBytes(linkDescriptor());
  const blob = new BlobRepo().storeBlob(
    conn, path.join(root, 'vfs_blobs'), bytes, 'application/json', 'json');
  const link = new FileRepo().createFile(
    conn, 'sha_link', '线性代数 第1讲.bilibili', bytes.length, 'video',
    'video/x-bilibili', blob.hash, null);

  const parsed = await host.invoke('media_bilibili_link_get', { resourceId: link.id });
  expect(parsed).toEqual({
    ...linkDescriptor(),
    cover: 'https://i0.hdslb.com/bfs/archive/a.jpg',
  });
  expect(await host.invoke('media_bilibili_link_get', { resourceId: link.id })).toEqual(parsed);
});

it('media_bilibili_link_get rejects non-link files and missing content', async () => {
  insertFile('file_talk', 'talk.mp3', 'audio/mpeg');
  await expect(host.invoke('media_bilibili_link_get', { resourceId: 'file_talk' }))
    .rejects.toThrow('不是 B 站链接条目: talk.mp3');

  const empty = new FileRepo().createFile(
    conn, 'sha_empty', '空.bilibili', 10, 'video', 'video/x-bilibili', null, null);
  await expect(host.invoke('media_bilibili_link_get', { resourceId: empty.id }))
    .rejects.toThrow(`媒体文件内容缺失: ${empty.id}`);

  const broken = new FileRepo().createFile(
    conn, 'sha_broken', '坏.bilibili', 7, 'video', 'video/x-bilibili', null, null);
  const brokenBlob = new BlobRepo().storeBlob(
    conn, path.join(root, 'vfs_blobs'), Buffer.from('{bad}'), 'application/json', 'json');
  conn.run('UPDATE files SET blob_hash = ?1 WHERE id = ?2', [brokenBlob.hash, broken.id]);
  await expect(host.invoke('media_bilibili_link_get', { resourceId: broken.id }))
    .rejects.toThrow('不是有效的 B 站链接条目');
});

it('L18-M05 mediaTranscriber backend records media_transcription usage with Rust error text', async () => {
  const blobsDir = path.join(root, 'vfs_blobs');
  fs.mkdirSync(blobsDir, { recursive: true });
  const wavPath = path.join(blobsDir, 'usage.wav');
  lectureWav(wavPath, [
    [0.5, false], [2.0, true], [1.5, false], [2.0, true], [1.5, false], [2.0, true], [0.5, false],
  ], 16_000);
  insertMediaFile('file_usage', wavPath);
  let requests = 0;
  const server = await startServer((request, response) => {
    requests += 1;
    if (requests === 1) {
      response.writeHead(400, { 'content-type': 'text/plain' });
      response.end('bad audio');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ text: '讲到这里' }));
  });
  const llm = {
    getModelAssignments: async () => ({ voice_input_asr_model_config_id: 'media-asr' }),
    getApiConfigs: async () => [{
      id: 'media-asr', vendorName: 'Relay', providerType: 'custom', apiProtocol: null,
      apiKey: 'sk-media', baseUrl: `${server.url}/v1`, model: 'Qwen/Qwen3-ASR-1.7B', enabled: true,
      headers: null,
    }],
  };
  const viaLlmHttp: string[] = [];
  const llmHttp = { fetch: (input: string | URL | Request, init?: RequestInit) => {
    viaLlmHttp.push(String(input));
    return fetch(input, init);
  } };
  const usageHost = await createTestHost({
    plugins: [media],
    provide: {
      settings: settings(), vfsDatabase: database, nativeAudio, paths: { appDataDir: root },
      vfsRepo: repos, storage, llm, llmHttp,
    },
  });
  const warnings: string[] = [];
  const stopLogging = usageHost.ctx.logger.exporter({
    levels: { default: 3 },
    export(message) {
      if (message.name === 'media.commands' && message.type === 'warn') {
        warnings.push(String(message.args[0]));
      }
    },
  });
  const timeouts = vi.spyOn(AbortSignal, 'timeout');
  try {
    const result = await usageHost.ctx.mediaTranscriber.transcribe({
      fileId: 'file_usage',
      tempDir: path.join(root, 'tmp', 'media'),
      imported: false,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    expect(result).toMatchObject({ totalSegments: 3, doneSegments: 2, failedSegments: 1 });
    expect(requests).toBe(3);
    expect(viaLlmHttp).toEqual(Array(3).fill(`${server.url}/v1/audio/transcriptions`));
    expect(timeouts.mock.calls.map(call => call[0])).toEqual([120_000, 120_000, 120_000]);

    const rows = storage.database('llm_usage').all<Record<string, unknown>>(
      "SELECT * FROM llm_usage_logs WHERE caller_type = 'media_transcription' ORDER BY rowid ASC");
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatchObject({
        provider: 'custom',
        model: 'Qwen/Qwen3-ASR-1.7B',
        api_config_id: 'media-asr',
        prompt_tokens: 0,
        completion_tokens: 0,
        token_source: 'heuristic',
      });
      expect(Number.isInteger(row.duration_ms)).toBe(true);
    }
    expect(rows.filter(row => row.status === 'error').map(row => row.error_message))
      .toEqual(['HTTP 400 bad audio']);
    expect(rows.filter(row => row.status === 'success')).toHaveLength(2);
    expect(warnings.some(line => line.endsWith('failed: HTTP 400 bad audio'))).toBe(true);
  } finally {
    timeouts.mockRestore();
    stopLogging();
    await usageHost.dispose();
    await server.close();
  }
});

it('R1-MD-05 media_transcript_import reads through read_all_bytes_bounded (commands.rs:433-436)', async () => {
  insertFile('file_bounded', 'talk.mp3', 'audio/mpeg');
  pdfRunning = true;
  const oversized = path.join(root, 'huge.srt');
  fs.writeFileSync(oversized, '');
  fs.truncateSync(oversized, MAX_SUBTITLE_BYTES + 1);
  const rejected = await host.invoke('media_transcript_import', {
    resourceId: 'file_bounded', path: oversized,
  }).then(() => null, (error: unknown) => error);
  expect(JSON.parse(rejected as string)).toEqual({
    code: 'io-failed',
    message: `文件过大: ${MAX_SUBTITLE_BYTES + 1} 字节，超过读取上限 ${MAX_SUBTITLE_BYTES} 字节: ${oversized}`,
  });
  expect(pdfRunning).toBe(true);

  // classify_path/extract_file_name：file:// 前缀与百分号编码的文件名
  pdfRunning = false;
  const named = path.join(root, '字幕 1.srt');
  fs.writeFileSync(named, '1\n00:00:00,000 --> 00:00:01,000\n你好\n');
  const view = await host.invoke('media_transcript_import', {
    resourceId: 'file_bounded', path: `file://${encodeURI(named)}`,
  });
  expect(view).toMatchObject({ status: 'queued', segments: [{ text: '你好' }] });
});

it('R1-MD-05 media_transcript_export uses write_text_file and creates the parent directory', async () => {
  insertFile('file_export_dir', 'talk.mp3', 'audio/mpeg');
  new MediaTranscriptRepo().setImportedSegments(conn, 'file_export_dir', [
    [{ startMs: 0, endMs: 1_000 }, '第一句'],
  ]);
  const dest = path.join(root, 'nested', 'deeper', 'talk.vtt');
  const exported = await host.invoke('media_transcript_export', {
    resourceId: 'file_export_dir', format: 'vtt', dest,
  });
  expect(exported).toMatchObject({ path: dest, format: 'vtt', segments: 1 });
  expect(fs.readFileSync(dest, 'utf8')).toContain('第一句');

  const blocker = path.join(root, 'blocker');
  fs.writeFileSync(blocker, 'file');
  const rejected = await host.invoke('media_transcript_export', {
    resourceId: 'file_export_dir', format: 'vtt', dest: path.join(blocker, 'talk.vtt'),
  }).then(() => null, (error: unknown) => error);
  const payload = JSON.parse(rejected as string) as { code: string; message: string };
  expect(payload.code).toBe('io-failed');
  expect(payload.message.startsWith(`写入文件失败: ${path.join(blocker, 'talk.vtt')} (`)).toBe(true);
});

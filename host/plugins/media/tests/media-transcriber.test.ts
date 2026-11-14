import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { audio as nativeAudio } from '../../../platform/native/audio/index.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
// boundary-allow cross-plugin-impl: 测试使用 L11 真实仓储验证落库与内容解析
import { AttachmentRepo } from '../../vfs-repos/repository/attachments.ts';
// boundary-allow cross-plugin-impl: 同上；extracted_text 经 L11 files owner 写入
import { FileRepo } from '../../vfs-repos/repository/files.ts';
// boundary-allow cross-plugin-impl: 同上；转写段与转写文本由真实仓储持久化
import { MediaTranscriptRepo } from '../../vfs-repos/repository/media-transcripts.ts';
import { AsrEndpoint } from '../src/asr.ts';
import { HttpAsrBackend } from '../src/asr-backend.ts';
import type { AsrBackendLike } from '../src/asr-runner.ts';
import { mediaTranscriptionLock, transcribeResource } from '../src/pipeline.ts';
import { startServer } from './helpers/http-fixture.ts';
import { lectureWav } from './helpers/wav-fixture.ts';

let template: string;
let root: string;
let storage: ReturnType<typeof createStorageService>;
let conn: DatabaseHandle;
let database: VfsDatabase;
let repos: VfsReposService;
let transcripts: MediaTranscriptRepo;
let tempDir: string;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

beforeAll(async () => {
  template = fs.mkdtempSync(path.join(os.tmpdir(), 'media-transcriber-schema-'));
  const source = createStorageService({ baseDir: template, dataLocalDir: template });
  try {
    const report = await source.migrations.runAll();
    expect(report.success, report.error ?? '').toBe(true);
  } finally { source.dispose(); }
}, 120_000);

afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-transcriber-'));
  fs.cpSync(template, root, { recursive: true });
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  conn = storage.database('vfs');
  database = {
    getConnSafe: () => conn,
    blobsDir: () => path.join(root, 'vfs_blobs'),
  } as unknown as VfsDatabase;
  transcripts = new MediaTranscriptRepo();
  repos = {
    files: new FileRepo(),
    mediaTranscripts: transcripts,
    attachments: new AttachmentRepo(),
  } as unknown as VfsReposService;
  tempDir = path.join(root, 'tmp', 'media');
  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'vfs_blobs'), { recursive: true });
});

afterEach(() => {
  storage?.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

function insertMediaFile(id: string, filePath: string): void {
  conn.run(
    `INSERT INTO files (id, sha256, file_name, original_path, size, mime_type, type, status,
                        created_at, updated_at)
     VALUES (?1, ?2, 'lecture.wav', ?3, 1000, 'audio/wav', 'audio', 'active',
             '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    [id, `sha_${id}`, filePath],
  );
}

it('transcribe_resource_end_to_end_with_mock_asr_and_resume', async () => {
  const wavPath = path.join(root, 'lecture.wav');
  lectureWav(wavPath, [
    [0.5, false],
    [2.0, true],
    [1.5, false],
    [2.0, true],
    [1.5, false],
    [2.0, true],
    [0.5, false],
  ], 16_000);
  insertMediaFile('file_lecture', wavPath);

  let requests = 0;
  const server = await startServer((request, response) => {
    requests += 1;
    if (request.url !== '/v1/audio/transcriptions') {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    if (requests === 2) {
      response.writeHead(400, { 'content-type': 'text/plain' });
      response.end('bad audio');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ text: requests === 4 ? '补上' : '讲到这里' }));
  });
  try {
    const backend = new HttpAsrBackend(new AsrEndpoint(
      'siliconflow', 'SiliconFlow', `${server.url}/v1`, 'sk-test', 'Qwen/Qwen3-ASR-1.7B', null,
    ), null, (input, init) => fetch(input, init));
    const stages: string[] = [];
    const first = await transcribeResource({
      database,
      repos,
      audio: nativeAudio,
      fileId: 'file_lecture',
      backend,
      tempDir,
      signal: undefined,
      onProgress: update => { stages.push(update.stage); },
    });

    expect(first.totalSegments).toBe(3);
    expect(first.doneSegments + first.failedSegments).toBe(3);
    expect(first.failedSegments).toBe(1);
    expect(stages[0]).toBe('queued');
    expect(stages).toContain('decode');
    expect(stages).toContain('asr');

    const extracted = conn.get<{ extracted_text: string }>(
      'SELECT extracted_text FROM files WHERE id = ?1', ['file_lecture']);
    expect(extracted?.extracted_text).toBeDefined();
    expect(extracted!.extracted_text.split('\n')).toHaveLength(2);
    expect(extracted!.extracted_text.startsWith('[00:00] 讲到这里')).toBe(true);

    const planBefore = transcripts.planInfo(conn, 'file_lecture')!;
    const second = await transcribeResource({
      database,
      repos,
      audio: nativeAudio,
      fileId: 'file_lecture',
      backend,
      tempDir,
      signal: undefined,
      onProgress: () => undefined,
    });
    expect(second.doneSegments).toBe(3);
    expect(second.failedSegments).toBe(0);
    expect(transcripts.planInfo(conn, 'file_lecture')).toEqual(planBefore);
    expect(requests).toBe(4);

    const duration = conn.get<{ duration_ms: number }>(
      'SELECT duration_ms FROM media_progress WHERE resource_id = ?1', ['file_lecture']);
    expect(duration?.duration_ms).toBe(10_000);
  } finally { await server.close(); }
});

it('transcription_is_single_flight_and_cancellable_while_queued', async () => {
  const wavPath = path.join(root, 'queued.wav');
  lectureWav(wavPath, [[1.0, true]], 16_000);
  insertMediaFile('file_queued', wavPath);

  const never: AsrBackendLike = {
    async transcribe(): Promise<never> { throw new Error('must wait for the transcription lock'); },
    modelLabel: () => 'never',
  };
  const release = await mediaTranscriptionLock.acquire();
  try {
    const controller = new AbortController();
    let settled = false;
    const task = transcribeResource({
      database,
      repos,
      audio: nativeAudio,
      fileId: 'file_queued',
      backend: never,
      tempDir,
      signal: controller.signal,
      onProgress: () => undefined,
    }).finally(() => { settled = true; });

    await sleep(50);
    expect(settled).toBe(false);
    controller.abort();
    await expect(task).rejects.toMatchObject({ code: 'cancelled' });
  } finally {
    release();
  }
});

it('imported_subtitle_plan_skips_asr_and_writes_transcript_text', async () => {
  const wavPath = path.join(root, 'imported.wav');
  lectureWav(wavPath, [[1.0, true]], 16_000);
  insertMediaFile('file_imported', wavPath);
  transcripts.setImportedSegments(conn, 'file_imported', [
    [{ startMs: 0, endMs: 1_000 }, '导入字幕'],
  ]);

  let asrCalls = 0;
  const never: AsrBackendLike = {
    async transcribe(): Promise<never> { asrCalls += 1; throw new Error('must not run'); },
    modelLabel: () => 'never',
  };
  let refreshed = 0;
  const stages: string[] = [];
  const result = await transcribeResource({
    database,
    repos,
    audio: nativeAudio,
    fileId: 'file_imported',
    backend: never,
    tempDir,
    signal: undefined,
    onProgress: update => { stages.push(update.stage); },
    refreshIndex: () => { refreshed += 1; },
  });

  expect(result).toMatchObject({ doneSegments: 1, totalSegments: 1, failedSegments: 0 });
  expect(result.transcriptChars).toBeGreaterThan(0);
  expect(asrCalls).toBe(0);
  expect(refreshed).toBe(1);
  expect(stages).toEqual(['queued']);
  const extracted = conn.get<{ extracted_text: string }>(
    'SELECT extracted_text FROM files WHERE id = ?1', ['file_imported']);
  expect(extracted?.extracted_text).toBe('[00:00] 导入字幕');
});

// pipeline.rs:331-341 write_transcript_text：空转写写 NULL（:335），经 L11 owner、只动 extracted_text。
it('write_transcript_text stores NULL for an empty transcript through the files owner', async () => {
  const wavPath = path.join(root, 'blank.wav');
  lectureWav(wavPath, [[1.0, true]], 16_000);
  insertMediaFile('file_blank', wavPath);
  conn.run("UPDATE files SET extracted_text = 'stale' WHERE id = 'file_blank'");
  transcripts.setImportedSegments(conn, 'file_blank', [[{ startMs: 0, endMs: 1_000 }, '   ']]);
  const before = conn.get<Record<string, unknown>>("SELECT * FROM files WHERE id = 'file_blank'")!;

  const result = await transcribeResource({
    database, repos, audio: nativeAudio, fileId: 'file_blank',
    backend: { async transcribe(): Promise<never> { throw new Error('must not run'); }, modelLabel: () => 'never' },
    tempDir, signal: undefined, onProgress: () => undefined,
  });

  expect(result.transcriptChars).toBe(0);
  const after = conn.get<Record<string, unknown>>("SELECT * FROM files WHERE id = 'file_blank'")!;
  expect(after).toEqual({ ...before, extracted_text: null });
});

// pipeline.rs:336-339 自动提交的 UPDATE 出错时经 `?` 上抛；files 行保持不变。
it('write_transcript_text propagates the owner SQL error and leaves the row unchanged', async () => {
  const wavPath = path.join(root, 'reject.wav');
  lectureWav(wavPath, [[1.0, true]], 16_000);
  insertMediaFile('file_reject', wavPath);
  transcripts.setImportedSegments(conn, 'file_reject', [[{ startMs: 0, endMs: 1_000 }, '导入字幕']]);
  conn.exec(`CREATE TRIGGER reject_transcript_text BEFORE UPDATE OF extracted_text ON files
    BEGIN SELECT RAISE(ABORT, 'extracted_text rejected'); END;`);
  const before = conn.get<Record<string, unknown>>("SELECT * FROM files WHERE id = 'file_reject'")!;

  await expect(transcribeResource({
    database, repos, audio: nativeAudio, fileId: 'file_reject',
    backend: { async transcribe(): Promise<never> { throw new Error('must not run'); }, modelLabel: () => 'never' },
    tempDir, signal: undefined, onProgress: () => undefined,
  })).rejects.toThrow('extracted_text rejected');
  expect(conn.get("SELECT * FROM files WHERE id = 'file_reject'")).toEqual(before);
});

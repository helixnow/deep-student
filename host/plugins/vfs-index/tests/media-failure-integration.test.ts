import fs from 'node:fs';
import path from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { audio } from '../../../platform/native/audio/index.ts';
// boundary-allow cross-plugin-impl: install the real registered L18 transcription provider
import mediaPlugin from '../../media/index.ts';
// boundary-allow cross-plugin-impl: install the real L13 database and media index provider
import vfsPlugin from '../../vfs/index.ts';
// boundary-allow cross-plugin-impl: install the real L11 SQLite owners
import reposPlugin from '../../vfs-repos/index.ts';
// boundary-allow cross-plugin-impl: L13 requires the real notes provider
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: reuse only the test WAV input generator, not media implementation
import { lectureWav } from '../../media/tests/helpers/wav-fixture.ts';
import plugin from '../index.ts';
import { pathsServiceDouble } from './support/paths-service.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: TestHost | undefined;
const logs: Array<{ level: string; message: string }> = [];
const timeline: unknown[] = [];
const releases: Array<() => void | Promise<void>> = [];
const configDisplay = '未配置语音识别：请在「设置 → 模型分配」选择语音识别（ASR）模型，或填写 SiliconFlow API Key 使用默认模型';
const configPayload = `{"code":"settings-required","message":"${configDisplay}"}`;
const asrDisplay = 'ASR 鉴权失败，请检查语音识别 API Key（HTTP 401 denied）';
const asrPayload = `{"code":"auth-failed","message":"${asrDisplay}"}`;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** `start_pipeline` returns before its `tokio::spawn`ed task runs; give that task one turn. */
function spawnedTaskTurn(): Promise<void> {
  return new Promise<void>(resolve => { setTimeout(resolve, 0); });
}

beforeAll(async () => {
  root = fs.mkdtempSync('/tmp/opencode/vfs-media-failure-');
  storage = createStorageService({ baseDir: root, dataLocalDir: path.join(root, 'local') });
  const report = await storage.migrations.runAll();
  if (!report.success) throw new Error(report.error ?? 'migration failed');
}, 180_000);

afterEach(async () => {
  for (const release of releases.splice(0)) await release();
  await host?.dispose();
  host = undefined;
  logs.length = 0;
  timeline.length = 0;
});

afterAll(() => {
  storage?.dispose();
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

async function install(provide: Record<string, unknown> = {}) {
  host = await createTestHost({
    plugins: [reposPlugin, notesPlugin, vfsPlugin, plugin, mediaPlugin],
    provide: {
      storage, nativeAudio: audio,
      paths: { ...pathsServiceDouble(), appDataDir: root },
      settings: { get: () => null, getSecret: async () => null },
      ...provide,
    },
  });
  host.ctx.logger.exporter({ levels: { default: 4 }, export(record) {
    const entry = { level: record.type, message: record.args.map(String).join(' ') };
    logs.push(entry);
    timeline.push(entry);
  } });
  for (const event of ['media-processing-progress', 'media-processing-error', 'media-processing-completed']) {
    host.ctx.backendEvents.listen(event, payload => {
      timeline.push({ event, payload, rows: storage.database('vfs').all('SELECT id, processing_status, processing_progress, processing_error, processing_completed_at FROM files ORDER BY id') });
    });
  }
  expect(Reflect.get(host.ctx.mediaTranscriber, 'version')).toBe(1);
  return host;
}

function file(mediaType: 'audio' | 'video') {
  const db = storage.database('vfs');
  const wav = path.join(root, 'input.wav');
  lectureWav(wav, [[0.5, false], [2, true], [0.5, false]], 16_000);
  const bytes = fs.readFileSync(wav);
  const mime = mediaType === 'audio' ? 'audio/wav' : 'video/mp4';
  const blob = host!.ctx.vfsRepo.blobs.storeBlob(db, host!.ctx.vfs.database.blobsDir(), bytes, mime);
  return host!.ctx.vfsRepo.files.createFileWithDocDataInFolder(db,
    `wp205-${crypto.randomUUID()}`, mediaType === 'audio' ? 'lecture.wav' : 'lecture.mp4',
    bytes.length, mediaType, mime, blob.hash, null, null, null, null, null);
}

function row(fileId: string) {
  return storage.database('vfs').get<Record<string, unknown>>('SELECT * FROM files WHERE id = ?1', [fileId])!;
}

async function settled(fileId: string) {
  // Observe accepted tasks without cancelling them via dispose().
  await expect.poll(() => host!.ctx.vfsIndex.pdf.isRunning(fileId)).toBe(false);
}

function evidence(name: string, fileId: string, returned: unknown) {
  process.stdout.write(`WP-205 RAW ${JSON.stringify({ name, fileId, returned: returned === undefined ? 'undefined (Ok)' : returned,
    row: row(fileId), events: host!.events, logs, timeline })}\n`);
}

function assertFailure(fileId: string, mediaType: 'audio' | 'video', stage: string,
  display: string, payload: string, rejected: boolean) {
  expect(logs.filter(log => log.level === 'warn')).toContainEqual({ level: 'warn',
    message: `[MediaProcessingService] Media transcription failed for ${fileId} at ${stage}: ${display}` });
  const second = rejected
    ? '[MediaProcessingService] Failed to set media error status: Database error: status write rejected'
    : `[PdfProcessingService] Set error for file ${fileId}: ${payload} (stage: ${stage === 'asr' ? 'Asr' : 'Queued'})`;
  expect(logs.filter(log => log.level === 'error')).toEqual([{ level: 'error', message: second }]);
  expect(host!.eventsNamed('media-processing-error')).toEqual([{ fileId, mediaType, stage, error: payload }]);
  expect(host!.eventsNamed('media-processing-completed')).toEqual([]);
  expect(host!.eventsNamed('pdf-processing-error')).toEqual([]);
  expect(host!.eventsNamed('pdf-processing-completed')).toEqual([]);
  expect(logs).toContainEqual({ level: 'info', message:
    `[MediaProcessingService] Pipeline completed for file: ${fileId} (type: ${mediaType === 'audio' ? 'Audio' : 'Video'})` });
  const warnIndex = timeline.findIndex(value => typeof value === 'object' && value !== null && 'message' in value
    && value.message === `[MediaProcessingService] Media transcription failed for ${fileId} at ${stage}: ${display}`);
  const errorIndex = timeline.findIndex(value => typeof value === 'object' && value !== null && 'message' in value && value.message === second);
  const emitIndex = timeline.findIndex(value => typeof value === 'object' && value !== null && 'event' in value && value.event === 'media-processing-error');
  expect(warnIndex).toBeLessThan(errorIndex);
  expect(errorIndex).toBeLessThan(emitIndex);
}

it.each(['audio', 'video'] as const)('WP-205 real L18 %s configuration failure stays in the inner queued branch', async mediaType => {
  const h = await install();
  const input = file(mediaType);
  const returned = await h.ctx.vfsIndex.pdf.startPipeline(input.id);
  await settled(input.id);
  evidence(`configuration-${mediaType}`, input.id, returned);
  expect(returned).toBeUndefined();
  expect(row(input.id)).toMatchObject({ processing_status: 'error', processing_error: configPayload, processing_progress: null });
  expect(row(input.id).processing_completed_at).toEqual(expect.any(Number));
  expect(h.eventsNamed('media-processing-progress')).toEqual([]);
  assertFailure(input.id, mediaType, 'queued', configDisplay, configPayload, false);
});

async function asrServer(hold = false) {
  const received = deferred<ServerResponse>();
  const requests: Array<{ method: string | undefined; url: string | undefined; bytes: number }> = [];
  const server = createServer((request, response) => {
    let bytes = 0;
    request.on('data', (chunk: Buffer) => { bytes += chunk.length; });
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, bytes });
      received.resolve(response);
      if (!hold) { response.writeHead(401); response.end('denied'); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  releases.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing HTTP fixture address');
  const viaLlmHttp: string[] = [];
  const llmHttp = { fetch: (input: string | URL | Request, init?: RequestInit) => {
    viaLlmHttp.push(String(input));
    return fetch(input, init);
  } };
  return { received, requests, viaLlmHttp, llmHttp, llm: {
    getModelAssignments: async () => ({ voice_input_asr_model_config_id: 'wp205-asr' }),
    getApiConfigs: async () => [{ id: 'wp205-asr', vendorName: 'Local', providerType: 'custom', providerScope: null,
      apiProtocol: null, apiKey: 'fixture-key', baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: 'Qwen/Qwen3-ASR-1.7B', enabled: true, headers: null }],
  } };
}

it.each([false, true])('WP-205 real L18 ASR HTTP failure keeps last progress and payload (set_error fails=%s)', async rejected => {
  const server = await asrServer();
  const h = await install({ llm: server.llm, llmHttp: server.llmHttp });
  const input = file('audio');
  const db = storage.database('vfs');
  if (rejected) db.exec(`CREATE TRIGGER wp205_reject_error BEFORE UPDATE OF processing_error ON files
    WHEN NEW.processing_status = 'error' BEGIN SELECT RAISE(ABORT, 'status write rejected'); END`);
  try {
    const returned = await h.ctx.vfsIndex.pdf.startPipeline(input.id);
    await settled(input.id);
    evidence(`asr-error-write-${rejected}`, input.id, returned);
    expect(returned).toBeUndefined();
    expect(server.requests).toEqual([{ method: 'POST', url: '/v1/audio/transcriptions', bytes: expect.any(Number) }]);
    expect(server.requests[0]!.bytes).toBeGreaterThan(0);
    expect(server.viaLlmHttp.map((url) => new URL(url).pathname)).toEqual(['/v1/audio/transcriptions']);
    expect(row(input.id)).toMatchObject({ processing_status: rejected ? 'asr' : 'error',
      processing_error: rejected ? null : asrPayload,
      processing_completed_at: rejected ? null : expect.any(Number) });
    expect(h.ctx.vfsIndex.pdf.getStatus(input.id)?.progress).toEqual({
      stage: 'asr', percent: 35, readyModes: [], mediaType: 'audio',
    });
    const progress = h.eventsNamed('media-processing-progress');
    expect(progress[0]).toMatchObject({ status: { stage: 'queued' } });
    expect(progress).toContainEqual(expect.objectContaining({ status: expect.objectContaining({ stage: 'decode' }) }));
    expect(progress.at(-1)).toMatchObject({ status: { stage: 'asr', percent: 35 }, completedSegments: 0, totalSegments: 1 });
    assertFailure(input.id, 'audio', 'asr', asrDisplay, asrPayload, rejected);
  } finally {
    if (rejected) db.exec('DROP TRIGGER wp205_reject_error');
  }
});

it('WP-205 real L18 queued cancellation logs info, resolves and preserves cancelled DB state', async () => {
  const server = await asrServer(true);
  const h = await install({ llm: server.llm, llmHttp: server.llmHttp });
  const occupying = file('audio');
  const cancelled = file('video');
  await h.ctx.vfsIndex.pdf.startPipeline(occupying.id);
  const response = await server.received.promise;
  const returned = await h.ctx.vfsIndex.pdf.startPipeline(cancelled.id);
  const cancelledTask = [...Reflect.get(h.ctx.vfsIndex.pdf, 'tasks') as Set<Promise<void>>].at(-1)!;
  await expect.poll(() => h.ctx.vfsIndex.pdf.getStatus(cancelled.id)?.progress.stage).toBe('queued');
  expect(h.ctx.vfsIndex.pdf.cancelMedia(cancelled.id)).toBe(true);
  const before = row(cancelled.id);
  // A cancelled task is no longer in running; wait for the actual accepted task instead.
  await cancelledTask;
  evidence('cancelled', cancelled.id, returned);
  expect(row(cancelled.id)).toEqual(before);
  expect(row(cancelled.id)).toMatchObject({ processing_status: 'cancelled', processing_error: null, processing_completed_at: null });
  expect(returned).toBeUndefined();
  expect(logs).toContainEqual({ level: 'info', message: `[MediaProcessingService] Media transcription cancelled: ${cancelled.id}` });
  expect(logs).toContainEqual({ level: 'info', message: `[MediaProcessingService] Pipeline completed for file: ${cancelled.id} (type: Video)` });
  expect(logs.filter(log => log.level === 'error')).toEqual([]);
  expect(h.eventsNamed('media-processing-error')).toEqual([]);
  expect(h.eventsNamed('media-processing-completed')).toEqual([]);
  response.writeHead(401); response.end('denied');
  await settled(occupying.id);
});

it('WP-205 real L18 stale configuration failure cannot write, emit or remove the replacement generation', async () => {
  const keys = [deferred<null>(), deferred<null>()];
  let reads = 0;
  releases.push(() => { for (const key of keys) key.resolve(null); });
  const h = await install({ settings: { get: () => null, getSecret: async (name: string) => {
    if (name === 'builtin-siliconflow.api_key') return keys[reads++]!.promise;
    return null;
  } } });
  const input = file('audio');
  await h.ctx.vfsIndex.pdf.startPipeline(input.id);
  await spawnedTaskTurn();
  expect(h.ctx.vfsIndex.pdf.cancel(input.id)).toBe(true);
  await h.ctx.vfsIndex.pdf.startPipeline(input.id);
  await spawnedTaskTurn();
  const before = row(input.id);
  keys[0]!.resolve(null);
  await new Promise<void>(resolve => setImmediate(resolve));
  evidence('old-generation', input.id, undefined);
  expect(reads).toBe(2);
  expect(row(input.id)).toEqual(before);
  expect(h.ctx.vfsIndex.pdf.isRunning(input.id)).toBe(true);
  expect(h.eventsNamed('media-processing-error')).toEqual([]);
  expect(h.eventsNamed('media-processing-completed')).toEqual([]);
  keys[1]!.resolve(null);
  await settled(input.id);
  expect(h.eventsNamed('media-processing-error')).toEqual([{ fileId: input.id, stage: 'queued', mediaType: 'audio', error: configPayload }]);
});

it('WP-205 real L18 unknown SQLite exception retains the outer Pipeline failed path', async () => {
  const h = await install();
  const input = file('audio');
  const db = storage.database('vfs');
  h.ctx.vfsRepo.mediaTranscripts.setImportedSegments(db, input.id, [[{ startMs: 0, endMs: 1000 }, 'subtitle']]);
  db.exec(`CREATE TRIGGER wp205_reject_transcript BEFORE UPDATE OF extracted_text ON files
    BEGIN SELECT RAISE(ABORT, 'transcript rejected'); END`);
  try {
    const returned = await h.ctx.vfsIndex.pdf.startPipeline(input.id);
    await settled(input.id);
    evidence('unknown-sqlite-error', input.id, returned);
    expect(logs).toContainEqual({ level: 'error', message:
      `[MediaProcessingService] Pipeline failed for file ${input.id} (type: Audio): transcript rejected` });
    expect(logs.filter(log => log.message.includes('Media transcription failed'))).toEqual([]);
    expect(h.eventsNamed('media-processing-error')).toEqual([{ fileId: input.id, mediaType: 'audio', stage: 'queued', error: 'transcript rejected' }]);
    expect(row(input.id)).toMatchObject({ processing_status: 'error', processing_error: 'transcript rejected' });
    expect(h.eventsNamed('media-processing-completed')).toEqual([]);
  } finally { db.exec('DROP TRIGGER wp205_reject_transcript'); }
});

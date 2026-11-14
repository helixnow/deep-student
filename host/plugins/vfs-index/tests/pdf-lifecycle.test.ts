import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { testFiles } from './support/files.ts';
// boundary-allow cross-plugin-impl: exercise real L11 owners during L12 plugin teardown
import reposPlugin from '../../vfs-repos/index.ts';
import plugin from '../index.ts';
import { vfsTableOwners } from '../repository/owners.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { MediaError, type MediaTranscriptionRequest } from '../../media/api.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: TestHost | undefined;
const releases: Array<() => void> = [];

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** `start_pipeline` returns before its `tokio::spawn`ed task runs; give that task one turn. */
function spawnedTaskTurn(): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}

beforeAll(async () => {
  root = fs.mkdtempSync('/tmp/opencode/vfs-pdf-lifecycle-');
  storage = createStorageService({ baseDir: root, dataLocalDir: path.join(root, 'local') });
  const report = await storage.migrations.runAll();
  if (!report.success) throw new Error(report.error ?? 'migration failed');
}, 180_000);

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await host?.dispose();
  host = undefined;
});

afterAll(() => {
  storage?.dispose();
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

async function install(provide: Record<string, unknown>) {
  host = await createTestHost({ plugins: [reposPlugin, plugin], provide: { files: testFiles(storage), 
    storage, paths: pathsServiceDouble(), settings: { get: () => null }, ...provide,
  } });
  return host;
}

function file(mime: string) {
  const db = storage.database('vfs');
  const repos = host!.ctx.vfsRepo;
  const bytes = Buffer.from('lifecycle input');
  const blob = repos.blobs.storeBlob(db, path.join(storage.locations.activeDir, 'vfs_blobs'), bytes, mime);
  return repos.files.createFileWithDocDataInFolder(db, `lifecycle-${crypto.randomUUID()}`,
    mime === 'image/png' ? 'scan.png' : mime === 'application/pdf' ? 'book.pdf' : 'clip.mp3', bytes.length, 'file', mime,
    blob.hash, null, null, null, null, null);
}

it.each([false, true])('WP-009 unload drains image OCR and its temporary file (failure=%s)', async (fail) => {
  const entered = deferred<string>();
  const response = deferred<string>();
  releases.push(() => response.resolve('late OCR text'));
  const h = await install({
    llmOcrModels: { inspectFreeTextOcrAvailable: async () => true }, llmOcrHedge: {},
    llmOcrPages: { async callOcrFreeTextWithFallback(imagePath: string) {
      entered.resolve(imagePath);
      const text = await response.promise;
      if (fail) throw new Error('late OCR failure');
      return text;
    } },
  });
  const image = file('image/png');
  const pdf = h.ctx.vfsIndex.pdf;
  await pdf.startPipeline(image.id, 'ocr_processing');
  const imagePath = await entered.promise;
  expect(fs.existsSync(imagePath)).toBe(true);
  expect(pdf.runningCount()).toBe(1);
  const db = storage.database('vfs');
  const before = db.get('SELECT processing_status, processing_progress, processing_error FROM files WHERE id = ?1', [image.id]);
  let unloaded = false;
  const unload = h.unload('dstu.vfs-index').then(() => { unloaded = true; });
  // Let Cordis enter its asynchronous disposers while the external OCR is held.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(unloaded).toBe(false);
  expect(pdf.runningCount()).toBe(0);
  expect(vfsTableOwners(db)).toBeDefined();
  response.resolve('late OCR text');
  await unload;
  expect(fs.existsSync(imagePath)).toBe(false);
  expect(vfsTableOwners(db)).toBeUndefined();
  expect(db.get('SELECT processing_status, processing_progress, processing_error FROM files WHERE id = ?1', [image.id])).toEqual(before);
  expect(db.pluck('SELECT ocr_text FROM resources WHERE id = ?1', [image.resourceId!])).toBeNull();
  expect(h.eventsNamed('media-processing-completed')).toEqual([]);
  expect(h.eventsNamed('media-processing-error')).toEqual([]);
});

it('WP-009 cancelled old generation cannot remove its replacement, and unload drains both tasks', async () => {
  const requests: MediaTranscriptionRequest[] = [];
  const responses = [deferred<void>(), deferred<void>()];
  releases.push(...responses.map((response) => () => response.resolve()));
  const h = await install({ mediaTranscriber: { async transcribe(request: MediaTranscriptionRequest) {
    const index = requests.push(request) - 1;
    await responses[index]!.promise;
    request.onProgress?.({ stage: 'asr', percent: 80 });
    return { transcriptChars: 0, doneSegments: 0, totalSegments: 0, failedSegments: 0 };
  } } });
  const audio = file('audio/mpeg');
  const pdf = h.ctx.vfsIndex.pdf;
  // Seed the private AtomicU64 counterpart; all transitions still use the public pipeline.
  expect(Reflect.get(pdf, 'generationCounter')).toBe(0n);
  Reflect.set(pdf, 'generationCounter', 18446744073709551615n);
  await pdf.startPipeline(audio.id);
  await spawnedTaskTurn();
  expect(Reflect.get(pdf, 'generationCounter')).toBe(0n);
  expect(pdf.cancel(audio.id)).toBe(true);
  await pdf.startPipeline(audio.id);
  await spawnedTaskTurn();
  expect(Reflect.get(pdf, 'generationCounter')).toBe(1n);
  expect(requests[0]!.signal.aborted).toBe(true);
  expect(requests[1]!.signal.aborted).toBe(false);
  responses[0]!.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(pdf.isRunning(audio.id)).toBe(true);
  expect(pdf.getStatus(audio.id)?.stage).toBe('queued');
  expect(h.eventsNamed('media-processing-completed')).toEqual([]);
  const unload = h.unload('dstu.vfs-index');
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(requests[1]!.signal.aborted).toBe(true);
  responses[1]!.resolve();
  await unload;
  expect(pdf.runningCount()).toBe(0);
  expect(h.eventsNamed('media-processing-progress')).toEqual([]);
});

it('WP-009 unload still waits for an already-cancelled task', async () => {
  const response = deferred<void>();
  releases.push(() => response.resolve());
  let finished = false;
  const h = await install({ mediaTranscriber: { async transcribe() {
    await response.promise;
    finished = true;
    return { transcriptChars: 0, doneSegments: 0, totalSegments: 0, failedSegments: 0 };
  } } });
  const audio = file('audio/mpeg');
  const pdf = h.ctx.vfsIndex.pdf;
  await pdf.startPipeline(audio.id);
  expect(pdf.cancel(audio.id)).toBe(true);
  expect(pdf.runningCount()).toBe(0);
  let unloaded = false;
  const unload = h.unload('dstu.vfs-index').then(() => { unloaded = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(unloaded).toBe(false);
  response.resolve();
  await unload;
  expect(finished).toBe(true);
  expect(h.eventsNamed('media-processing-completed')).toEqual([]);
});

it.each([false, true])('WP-192 PDF outer failure preserves ERROR and both events (set_error fails=%s)', async (rejectError) => {
  const h = await install({});
  const document = file('application/pdf');
  const db = storage.database('vfs');
  const errors: string[] = [];
  h.ctx.logger.exporter({ levels: { default: 4 }, export(record) {
    if (record.type === 'error') errors.push(record.args.map(String).join(' '));
  } });
  // The real PDF runtime finishes with issues (no native text extractor). Its
  // final status write propagates, as Rust run_pdf_pipeline_internal's final ?.
  db.exec(`CREATE TRIGGER reject_pdf_completion BEFORE UPDATE OF processing_status ON files
    WHEN NEW.processing_status IN ('completed', 'completed_with_issues')
    BEGIN SELECT RAISE(ABORT, 'pdf completion rejected'); END`);
  if (rejectError) db.exec(`CREATE TRIGGER reject_processing_error BEFORE UPDATE OF processing_error ON files
    WHEN NEW.processing_status = 'error' BEGIN SELECT RAISE(ABORT, 'status write rejected'); END`);
  try {
    await h.ctx.vfsIndex.pdf.startPipeline(document.id);
    await spawnedTaskTurn();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.ctx.vfsIndex.pdf.runningCount()).toBe(0);
    expect(errors).toContain(`[MediaProcessingService] Pipeline failed for file ${document.id} (type: Pdf): Database error: pdf completion rejected`);
    if (rejectError) {
      expect(errors).toContain('[MediaProcessingService] Failed to set error status: Database error: status write rejected');
    } else {
      expect(errors).toContain(`[PdfProcessingService] Set error for file ${document.id}: Database error: pdf completion rejected (stage: OcrProcessing)`);
      expect(h.ctx.vfsIndex.pdf.getStatus(document.id)?.error).toBe('Database error: pdf completion rejected');
      expect(h.ctx.vfsIndex.pdf.getStatus(document.id)?.stage).toBe('error');
    }
    const expected = [{ fileId: document.id, error: 'Database error: pdf completion rejected', stage: 'ocr_processing', mediaType: 'pdf' }];
    expect(h.eventsNamed('media-processing-error')).toEqual(expected);
    expect(h.eventsNamed('pdf-processing-error')).toEqual(expected);
    expect(h.eventsNamed('media-processing-completed')).toEqual([]);
    expect(h.eventsNamed('pdf-processing-completed')).toEqual([]);
  } finally {
    if (rejectError) db.exec('DROP TRIGGER reject_processing_error');
    db.exec('DROP TRIGGER reject_pdf_completion');
  }
});

it('WP-192 duplicate start warns, consumes a generation and preserves the running task', async () => {
  const response = deferred<void>();
  releases.push(() => response.resolve());
  const requests: MediaTranscriptionRequest[] = [];
  const h = await install({ mediaTranscriber: { async transcribe(request: MediaTranscriptionRequest) {
    requests.push(request);
    request.onProgress({ stage: 'asr', percent: 70 });
    await response.promise;
    return { transcriptChars: 0, doneSegments: 0, totalSegments: 0, failedSegments: 0 };
  } } });
  const audio = file('audio/mpeg');
  const warnings: string[] = [];
  h.ctx.logger.exporter({ levels: { default: 4 }, export(record) {
    if (record.type === 'warn') warnings.push(record.args.map(String).join(' '));
  } });
  const pdf = h.ctx.vfsIndex.pdf;
  await pdf.startPipeline(audio.id);
  await spawnedTaskTurn();
  const before = pdf.getStatus(audio.id);
  await pdf.startPipeline(audio.id);
  expect(Reflect.get(pdf, 'generationCounter')).toBe(2n);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.signal.aborted).toBe(false);
  expect(pdf.runningCount()).toBe(1);
  expect(pdf.getStatus(audio.id)).toEqual(before);
  expect(warnings).toContain(`[MediaProcessingService] Pipeline already running for file: ${audio.id}`);
  response.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(pdf.runningCount()).toBe(0);
  expect(pdf.getStatus(audio.id)?.stage).toBe('completed');
});

// Supplement the real-provider integration with the public string stage contract:
// Rust :1009 normalizes only set_error's Debug stage, never the original event stage.
it.each([
  ['\u0085 AsR \u0085', 'Asr'], ['future_asr', 'Pending'],
])('WP-205 last raw progress %s uses from_str only for set_error (%s)', async (stage, debug) => {
  const failure = new MediaError('AsrFatal', 'stage contract failure', 'auth-failed');
  const h = await install({ mediaTranscriber: { async transcribe(request: MediaTranscriptionRequest) {
    request.onProgress({ stage: 'decode', percent: 1 });
    request.onProgress({ stage, percent: 42 });
    throw failure;
  } } });
  const audio = file('audio/mpeg');
  const logs: Array<{ level: string; message: string }> = [];
  h.ctx.logger.exporter({ levels: { default: 4 }, export(record) {
    logs.push({ level: record.type, message: record.args.map(String).join(' ') });
  } });
  const returned = await h.ctx.vfsIndex.pdf.startPipeline(audio.id);
  await spawnedTaskTurn();
  await new Promise<void>(resolve => setImmediate(resolve));
  const payload = '{"code":"auth-failed","message":"stage contract failure"}';
  expect(returned).toBeUndefined();
  expect(h.ctx.vfsIndex.pdf.isRunning(audio.id)).toBe(false);
  expect(logs).toContainEqual({ level: 'error', message:
    `[PdfProcessingService] Set error for file ${audio.id}: ${payload} (stage: ${debug})` });
  expect(logs).toContainEqual({ level: 'warn', message:
    `[MediaProcessingService] Media transcription failed for ${audio.id} at ${stage}: stage contract failure` });
  expect(h.eventsNamed('media-processing-error')).toEqual([{ fileId: audio.id, error: payload, stage, mediaType: 'audio' }]);
  expect(h.ctx.vfsIndex.pdf.getStatus(audio.id)).toMatchObject({ stage: 'error', error: payload,
    progress: { stage, percent: 42, readyModes: [] } });
  expect(h.eventsNamed('media-processing-completed')).toEqual([]);
  process.stdout.write(`WP-205 STAGE RAW ${JSON.stringify({ stage, returned: 'undefined (Ok)',
    status: h.ctx.vfsIndex.pdf.getStatus(audio.id), logs, events: h.events })}\n`);
});

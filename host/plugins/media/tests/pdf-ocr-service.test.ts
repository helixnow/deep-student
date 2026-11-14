import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';
import {
  PdfOcrService, rateLimitHint, renderSize, sanitizePdfFileName,
} from '../src/pdf-ocr-service.ts';

type Payload = Record<string, unknown>;
type OcrCall = [string, number, string];

let root: string;
let host: TestHost | null = null;

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-ocr-')); });
afterEach(async () => {
  if (host !== null) await host.dispose();
  host = null;
  fs.rmSync(root, { recursive: true, force: true });
});

function settings(values = new Map<string, string>()) {
  return { get: (key: string) => values.get(key) ?? null, save: (key: string, value: string) => { values.set(key, value); } };
}

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function card(text: string, idx: number) {
  return { question_label: `区域${idx}`, bbox: { x: 0.25, y: 0.5, width: 0.5, height: 0.25 }, ocr_text: text,
    tags: [], extra_metadata: null, card_id: `ocr_p${idx}_r0` };
}

interface Fakes {
  calls: OcrCall[];
  ocr: (pagePath: string, pageIndex: number) => Promise<ReturnType<typeof card>[]>;
  configFails?: boolean;
  configGate?: Promise<void>;
  renderFailPages?: Set<number>;
  pageCount?: number;
  testCalls?: unknown[][];
}

async function start(fakes: Fakes, extra: Record<string, unknown> = {}): Promise<TestHost> {
  host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(),
      settings: settings(new Map([['ocr.available_models', JSON.stringify([{ configId: 'cfg-1', name: '我的 Paddle' }])]])),
      paths: { appDataDir: root },
      llmOcrModels: {
        getOcrEngineType: async () => 'paddle_ocr_vl',
        getOcrModelConfig: async () => {
          if (fakes.configGate !== undefined) await fakes.configGate;
          if (fakes.configFails) throw { error_type: 'Configuration', message: '没有可用的 OCR 模型', details: null };
          return { id: 'cfg-1', model: 'PaddlePaddle/PaddleOCR-VL-1.5' };
        },
      },
      llmOcrPages: {
        callOcrPageWithFallback: async (pagePath: string, pageIndex: number, task: string) => {
          fakes.calls.push([pagePath, pageIndex, task]);
          return fakes.ocr(pagePath, pageIndex);
        },
        testOcrWithEngine: async (...args: unknown[]) => {
          (fakes.testCalls ??= []).push(args);
          expect(fs.existsSync(args[0] as string)).toBe(true);
          if (args[2] === 'bad') throw { error_type: 'Configuration', message: '找不到配置 ID: bad', details: null };
          return { text: '你好', regions: [
            { label: 'text', text: '你好', bbox_normalized: [0.1, 0.2, 0.3, 0.4] },
            { label: 'title', text: 'x', bbox_normalized: [0.1] },
          ] };
        },
      },
      nativeImage: {
        dimensions: async () => ({ width: 640, height: 480 }),
        encode: async (input: { width: number; height: number }) => new Uint8Array([0xff, 0xd8, input.width & 0xff]),
      },
      nativePdfium: {
        open: async () => ({
          pageCount: fakes.pageCount ?? 3,
          page: async (index: number) => ({
            width: 612, height: 792, text: async () => '',
            render: async (opts: { width: number; height: number }) => {
              if (fakes.renderFailPages?.has(index)) throw new Error('bitmap alloc');
              return { width: opts.width, height: opts.height, rgba: new Uint8Array(4) };
            },
          }),
          close: async () => {},
        }),
        extractText: async () => '',
      },
      ...extra,
    },
    app: { platform: 'linux' },
  });
  return host;
}

function progress(h: TestHost, sessionId: string): Payload[] {
  return (h.eventsNamed('pdf_ocr_progress') as Payload[]).filter((p) => p.session_id === sessionId);
}

async function completed(h: TestHost, sessionId: string, timeoutMs = 10_000): Promise<Payload> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const done = progress(h, sessionId).find((p) => p.type === 'Completed');
    if (done !== undefined) return done;
    if (Date.now() > deadline) throw new Error(`no Completed for ${sessionId}: ${JSON.stringify(progress(h, sessionId))}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const PDF_B64 = Buffer.from('%PDF-1.4 fake').toString('base64');

it('upload session: saves PDF/pages, OCRs FreeText via L02, caches blocks, and is not cancellable (Rust)', async () => {
  const fakes: Fakes = { calls: [], ocr: async (_p, idx) => [card(`page ${idx}`, idx)] };
  const h = await start(fakes);
  const id = await h.invoke<string>('init_pdf_ocr_session', { pdfName: '高数 期末.pdf', pdfBase64: `data:application/pdf;base64,${PDF_B64}`, totalPages: 2 });
  const sessionDir = path.join(root, 'pdf_ocr_sessions', id);
  const saved = fs.readdirSync(sessionDir);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatch(/^\d{8}_\d{6}_pdf\.pdf$/);

  // Rust keeps upload-session senders out of the control maps.
  expect(await h.invoke('cancel_pdf_ocr_session', { sessionId: id })).toBe(false);
  expect(await h.invoke('pause_pdf_ocr_session', { sessionId: id })).toBe(false);
  expect(await h.invoke('skip_pdf_ocr_page', { sessionId: id, pageIndex: 0 })).toBe(true);

  expect(await h.invoke('upload_pdf_ocr_page', { sessionId: id, page: { page_index: 0, image_base64: PNG_1x1, width: 100, height: 200 } })).toBeNull();
  expect(await h.invoke('upload_pdf_ocr_page', { sessionId: id, page: { page_index: 1, image_base64: `data:image/jpeg;base64,${PNG_1x1}` } })).toBeNull();
  const done = await completed(h, id);
  expect(done).toEqual({ type: 'Completed', session_id: id, total_pages: 2, success_count: 2, failed_count: 0, has_failures: false, cancelled: false });

  const events = progress(h, id);
  expect(events[0]).toEqual({ type: 'Started', total_pages: 2, session_id: id });
  const pages = events.filter((e) => e.type === 'PageCompleted').sort((a, b) => (a.page_index as number) - (b.page_index as number));
  // Skipped page 0 is still processed: Rust never reads pdf_ocr_skip_pages.
  expect(pages.map((p) => p.page_index)).toEqual([0, 1]);
  expect('cached' in pages[0]!).toBe(false);
  expect(pages[0]!.page_result).toEqual({ page_index: 0, width: 100, height: 200, blocks: [{ text: 'page 0', bbox: { x: 0.25, y: 0.5, width: 0.5, height: 0.25 } }] });
  expect((pages[1]!.page_result as Payload).width).toBe(640);
  expect(fakes.calls.map((c) => c[2])).toEqual(['FreeText', 'FreeText']);
  expect(fakes.calls.map((c) => c[0]).sort()).toEqual([`images/pdfocr_${id}_p0.png`, `images/pdfocr_${id}_p1.jpg`]);
  expect(fs.existsSync(path.join(root, 'images', `pdfocr_${id}_p1.jpg`))).toBe(true);

  const hash = createHash('sha256').update(Buffer.from('%PDF-1.4 fake')).digest('hex');
  const cached = JSON.parse(fs.readFileSync(path.join(root, 'pdf_ocr_cache', hash, 'page_00000.json'), 'utf8'));
  expect(cached).toEqual([{ text: 'page 0', bbox: { x: 0.25, y: 0.5, width: 0.5, height: 0.25 } }]);
});

it('upload_pdf_ocr_page on an unknown session is NotFound; bad base64 is Validation', async () => {
  const h = await start({ calls: [], ocr: async () => [] });
  await expect(h.invoke('upload_pdf_ocr_page', { sessionId: 'nope', page: { page_index: 0, image_base64: PNG_1x1 } }))
    .rejects.toEqual({ error_type: 'NotFound', message: 'Session nope not found', details: null });
  await expect(h.invoke('init_pdf_ocr_session', { pdfBase64: '@@@', totalPages: 1 }))
    .rejects.toMatchObject({ error_type: 'Validation', message: expect.stringMatching(/^base64解码失败: /) });
});

it('process_pdf_ocr returns the Rust placeholder result and reuses the page cache', async () => {
  const fakes: Fakes = { calls: [], ocr: async (_p, idx) => [card('t', idx)] };
  const h = await start(fakes);
  const request = { pdf_base64: PDF_B64, pdf_name: null, pages: [{ page_index: 0, image_base64: PNG_1x1, width: 1, height: 1 }] };
  const first = await h.invoke<Payload>('process_pdf_ocr', { request });
  expect(first).toEqual({ temp_id: first.temp_id, source_pdf_path: '', pdfstream_url: '', page_results: [] });
  await completed(h, first.temp_id as string);
  const second = await h.invoke<Payload>('process_pdf_ocr', { request });
  await completed(h, second.temp_id as string);
  expect(fakes.calls).toHaveLength(1);
  const cachedEvent = progress(h, second.temp_id as string).find((e) => e.type === 'PageCompleted')!;
  expect('cached' in cachedEvent).toBe(false);
  expect(cachedEvent.page_result).toEqual({ page_index: 0, width: 1, height: 1, blocks: [{ text: 't', bbox: { x: 0.25, y: 0.5, width: 0.5, height: 0.25 } }] });
});

it('upload worker: config failure emits PageFailed(0) and Completed with failed_count = total_pages', async () => {
  const h = await start({ calls: [], ocr: async () => [], configFails: true });
  const id = await h.invoke<string>('init_pdf_ocr_session', { pdfBase64: PDF_B64, totalPages: 3 });
  const done = await completed(h, id);
  expect(done).toEqual({ type: 'Completed', session_id: id, total_pages: 3, success_count: 0, failed_count: 3, has_failures: true, cancelled: false });
  expect(progress(h, id)).toContainEqual({ type: 'PageFailed', session_id: id, page_index: 0, error: '没有可用的 OCR 模型' });
});

// Rust run_worker owns page_rx (pdf_ocr_service.rs:880); every return drops it, so a send blocked on
// the full 32-slot channel (:150-153) and every later send fail with "OCR session closed".
const SESSION_CLOSED = { error_type: 'Unknown', message: 'OCR session closed', details: null };

function track(promise: Promise<unknown>): { state: 'pending' | 'fulfilled' | 'rejected'; reason?: unknown } {
  const box: { state: 'pending' | 'fulfilled' | 'rejected'; reason?: unknown } = { state: 'pending' };
  promise.then(() => { box.state = 'fulfilled'; }, (reason: unknown) => { box.state = 'rejected'; box.reason = reason; });
  return box;
}

async function until(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function pageInput(index: number) {
  return { page_index: index, image_base64: PNG_1x1, width: 10, height: 10 };
}

/** Fills the 32-slot channel, then starts a 33rd upload that must block in `send` after saving its image. */
async function blockOnFullChannel(h: TestHost, id: string, first: number) {
  for (let i = first; i < first + 32; i += 1) {
    expect(await h.invoke('upload_pdf_ocr_page', { sessionId: id, page: pageInput(i) })).toBeNull();
  }
  const blockedIndex = first + 32;
  const blocked = track(h.invoke('upload_pdf_ocr_page', { sessionId: id, page: pageInput(blockedIndex) }));
  const image = path.join(root, 'images', `pdfocr_${id}_p${blockedIndex}.png`);
  await until(() => fs.existsSync(image), 'blocked page image');
  await new Promise((r) => setTimeout(r, 100));
  expect(blocked.state).toBe('pending');
  return { blocked, blockedIndex };
}

async function expectClosedAfterExit(h: TestHost, id: string, blocked: ReturnType<typeof track>, nextIndex: number) {
  await until(() => blocked.state !== 'pending', 'blocked upload to settle after worker exit');
  expect(blocked).toEqual({ state: 'rejected', reason: SESSION_CLOSED });
  await expect(h.invoke('upload_pdf_ocr_page', { sessionId: id, page: pageInput(nextIndex) })).rejects.toEqual(SESSION_CLOSED);
  // prepare_page_image runs before send: the rejected page's image is still saved.
  expect(fs.existsSync(path.join(root, 'images', `pdfocr_${id}_p${nextIndex}.png`))).toBe(true);
}

it('upload worker normal exit drops page_rx: blocked and later upload_pdf_ocr_page fail with OCR session closed', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const fakes: Fakes = { calls: [], ocr: async (_p, idx) => { await gate; return [card(`page ${idx}`, idx)]; } };
  const h = await start(fakes);
  const id = await h.invoke<string>('init_pdf_ocr_session', { pdfBase64: PDF_B64, totalPages: 1 });
  expect(await h.invoke('upload_pdf_ocr_page', { sessionId: id, page: pageInput(0) })).toBeNull();
  await until(() => fakes.calls.length === 1, 'page 0 OCR call');

  const { blocked, blockedIndex } = await blockOnFullChannel(h, id, 1);
  release();
  const done = await completed(h, id);
  expect(done).toEqual({ type: 'Completed', session_id: id, total_pages: 1, success_count: 1, failed_count: 0, has_failures: false, cancelled: false });
  await expectClosedAfterExit(h, id, blocked, blockedIndex + 1);
  // Buffered pages are discarded with the receiver; only page 0 was ever OCR'd.
  expect(fakes.calls.map((c) => c[1])).toEqual([0]);
  expect(progress(h, id).map((e) => e.type)).toEqual(['Started', 'PageCompleted', 'Completed']);
});

it('upload worker config-failure exit drops page_rx: blocked and later upload_pdf_ocr_page fail with OCR session closed', async () => {
  let release!: () => void;
  const configGate = new Promise<void>((r) => { release = r; });
  const fakes: Fakes = { calls: [], ocr: async () => [], configFails: true, configGate };
  const h = await start(fakes);
  const id = await h.invoke<string>('init_pdf_ocr_session', { pdfBase64: PDF_B64, totalPages: 40 });

  const { blocked, blockedIndex } = await blockOnFullChannel(h, id, 0);
  release();
  expect(await completed(h, id)).toEqual({ type: 'Completed', session_id: id, total_pages: 40, success_count: 0, failed_count: 40, has_failures: true, cancelled: false });
  await expectClosedAfterExit(h, id, blocked, blockedIndex + 1);
  expect(fakes.calls).toEqual([]);
  expect(progress(h, id)).toEqual([
    { type: 'Started', total_pages: 40, session_id: id },
    { type: 'PageFailed', session_id: id, page_index: 0, error: '没有可用的 OCR 模型' },
    { type: 'Completed', session_id: id, total_pages: 40, success_count: 0, failed_count: 40, has_failures: true, cancelled: false },
  ]);
});

it('upload worker abnormal exit drops page_rx after logging the crash: blocked and later uploads fail with OCR session closed', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  // Fault the outer worker's finish logger, not a page task (JoinSet isolates page panics).
  const fakes: Fakes = {
    calls: [],
    ocr: async (_p, idx) => { await gate; return [card('x', idx)]; },
  };
  const h = await start(fakes);
  const crashes: string[] = [];
  const stop = h.ctx.logger.exporter({
    levels: { default: 3 },
    export(message) {
      if (message.name === 'media.pdf_ocr' && message.type === 'info'
        && String(message.args[0]).startsWith('[PDF-OCR] Worker finished:')) throw new Error('finish logger failed');
      if (message.name === 'media.pdf_ocr' && message.type === 'error') crashes.push(String(message.args[0]));
    },
  });
  try {
    const id = await h.invoke<string>('init_pdf_ocr_session', { pdfBase64: PDF_B64, totalPages: 1 });
    expect(await h.invoke('upload_pdf_ocr_page', { sessionId: id, page: pageInput(0) })).toBeNull();
    await until(() => fakes.calls.length === 1, 'page 0 OCR call');

    const { blocked, blockedIndex } = await blockOnFullChannel(h, id, 1);
    release();
    await until(() => crashes.length > 0, 'worker crash log');
    expect(crashes[0]).toMatch(/^\[PdfOcrService\] OCR worker crashed: /);
    await expectClosedAfterExit(h, id, blocked, blockedIndex + 1);
    expect(fakes.calls.map((c) => c[1])).toEqual([0]);
    expect(crashes).toEqual(['[PdfOcrService] OCR worker crashed: finish logger failed']);
  } finally {
    stop();
  }
});

it('backend session: renders with pdfium, retries 429 with backoff, records render failures', async () => {
  let rateLimited = false;
  const fakes: Fakes = {
    calls: [], renderFailPages: new Set([1]),
    ocr: async (_p, idx) => {
      if (idx === 2 && !rateLimited) {
        rateLimited = true;
        throw { error_type: 'LLM', message: 'busy', details: { status: 429, retry_after_ms: 10 } };
      }
      if (idx === 0) throw { error_type: 'LLM', message: 'bad request', details: { status: 400 } };
      return [card(`p${idx}`, idx)];
    },
  };
  const h = await start(fakes);
  const pdfPath = path.join(root, 'in.pdf');
  fs.writeFileSync(pdfPath, 'pdf-bytes');
  const id = await h.invoke<string>('start_pdf_ocr_backend', { pdfPath, pdfName: 'in.pdf', renderDpi: 999 });
  const done = await completed(h, id);
  expect(done).toEqual({
    type: 'Completed', session_id: id, total_pages: 3, success_count: 1, failed_count: 2, ocr_failed_count: 1,
    render_failed_count: 1, render_failed_pages: [1], has_failures: true, cancelled: false,
  });
  const events = progress(h, id);
  expect(events).toContainEqual({ type: 'RenderStarted', session_id: id, total_pages: 3 });
  expect(events).toContainEqual({ type: 'Started', session_id: id, total_pages: 3, pdf_name: 'in.pdf', render_dpi: 300 });
  expect(events).toContainEqual({ type: 'PageRenderFailed', session_id: id, page_index: 1, error: '渲染失败: bitmap alloc' });
  expect(events).toContainEqual({ type: 'Retrying', session_id: id, page_index: 2, attempt: 1, max_attempts: 3, backoff_ms: 1000, hint: 'retry_after_ms' });
  expect(events).toContainEqual({ type: 'PageFailed', session_id: id, page_index: 0, error: 'bad request' });
  const page2 = events.find((e) => e.type === 'PageCompleted' && e.page_index === 2)!;
  expect(page2.cached).toBe(false);
  // 300 DPI: target width 2550, max height 4200 → 612x792 pt → 2550x3300.
  expect(page2.page_result).toMatchObject({ width: 2550, height: 3300 });
  const imagePath = path.join(root, 'pdf_ocr_images', id, 'page_00002.jpg');
  expect(fs.existsSync(imagePath)).toBe(true);
  expect(fakes.calls.find((c) => c[1] === 2)![0]).toBe(imagePath);
}, 20_000);

// WP-138: these exercise the production PdfOcrService/ocrTask and real bounded channels.
// Only the L02/F7 ports supply controlled inputs; no worker or join implementation is replaced.
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function panickingCard(index: number, onRead = () => {}) {
  return { ...card('x', index), get bbox(): ReturnType<typeof card>['bbox'] { onRead(); throw new Error('page task exploded'); } };
}

function captureOcr(h: TestHost) {
  const trace: Array<{ kind: string; payload?: unknown; message?: string }> = [];
  h.ctx.backendEvents.listen('pdf_ocr_progress', (payload) => { trace.push({ kind: 'event', payload }); });
  const offLog = h.ctx.logger.exporter({
    levels: { default: 3 },
    export(message) {
      if (message.name === 'media.pdf_ocr') trace.push({ kind: message.type, message: String(message.args[0]) });
    },
  });
  return { trace, stop: offLog };
}

function productionService(h: TestHost, emit = (payload: Parameters<typeof h.ctx.backendEvents.emit>[1]) => {
  h.ctx.backendEvents.emit('pdf_ocr_progress', payload);
}) {
  return new PdfOcrService({
    appDataDir: () => root, imagesDir: () => path.join(root, 'images'),
    ocrModels: () => h.ctx.llmOcrModels, ocrPages: () => h.ctx.llmOcrPages,
    pdfium: () => h.ctx.nativePdfium, image: () => h.ctx.nativeImage,
    emit, log: h.ctx.logger('media.pdf_ocr'),
  });
}

it('WP-138 run_worker final join_next logs one task panic, retains the other page, then Completed and receiver close', async () => {
  const panic = deferred();
  const other = deferred();
  const fakes: Fakes = { calls: [], ocr: async (_p, idx) => {
    await (idx === 0 ? panic.promise : other.promise);
    return [idx === 0 ? panickingCard(idx) : card('survived', idx)];
  } };
  const h = await start(fakes);
  const capture = captureOcr(h);
  const service = productionService(h);
  const [id, session] = await service.startSession(PDF_B64, null, 3);
  try {
    await service.addPage(session.pageTx, id, pageInput(0));
    await service.addPage(session.pageTx, id, pageInput(1));
    await until(() => fakes.calls.length === 2, 'two active OCR tasks');
    // Fewer than total_pages: sender drop selects the final, logging drain (:1085,1111).
    session.pageTx.close();
    panic.resolve();
    await until(() => capture.trace.some((e) => e.kind === 'error'), 'join failure log');
    expect(capture.trace.filter((e) => e.kind === 'error')).toEqual([
      { kind: 'error', message: '[PdfOcrService] OCR task panicked: page task exploded' },
    ]);
    expect(progress(h, id)).toEqual([{ type: 'Started', total_pages: 3, session_id: id }]);
    other.resolve();
    expect(await completed(h, id)).toEqual({ type: 'Completed', session_id: id, total_pages: 3,
      success_count: 1, failed_count: 0, has_failures: false, cancelled: false });
    expect(progress(h, id)[1]).toEqual({ type: 'PageCompleted', session_id: id, page_index: 1,
      completed: 2, total: 3, page_result: { page_index: 1, width: 10, height: 10,
        blocks: [{ text: 'survived', bbox: card('', 1).bbox }] } });
    const ordered = capture.trace.filter((e) => e.kind === 'error' || e.kind === 'event');
    expect(ordered.map((e) => e.kind === 'event' ? (e.payload as Payload).type : e.message)).toEqual([
      'Started', '[PdfOcrService] OCR task panicked: page task exploded', 'PageCompleted', 'Completed',
    ]);
    await expect(service.addPage(session.pageTx, id, pageInput(2))).rejects.toMatchObject({ value: SESSION_CLOSED });
    console.log('WP-138 final-drain raw', JSON.stringify(capture.trace));
  } finally {
    session.pageTx.close(); panic.resolve(); other.resolve();
    await until(() => progress(h, id).some((e) => e.type === 'PageCompleted'), 'remaining page settled');
    capture.stop();
  }
});

it('WP-138 run_worker total-pages drain silently consumes task panic and still emits Completed', async () => {
  const gate = deferred();
  const fakes: Fakes = { calls: [], ocr: async (_p, idx) => {
    await gate.promise;
    return [idx === 0 ? panickingCard(idx) : card('survived', idx)];
  } };
  const h = await start(fakes);
  const capture = captureOcr(h);
  try {
    const id = await h.invoke<string>('init_pdf_ocr_session', { pdfBase64: PDF_B64, totalPages: 2 });
    for (const idx of [0, 1]) await h.invoke('upload_pdf_ocr_page', { sessionId: id, page: pageInput(idx) });
    await until(() => fakes.calls.length === 2, 'two active tasks');
    gate.resolve();
    expect(await completed(h, id)).toEqual({ type: 'Completed', session_id: id, total_pages: 2,
      success_count: 1, failed_count: 0, has_failures: false, cancelled: false });
    expect(progress(h, id).map((e) => [e.type, e.page_index])).toEqual([
      ['Started', undefined], ['PageCompleted', 1], ['Completed', undefined],
    ]);
    expect(capture.trace.filter((e) => e.kind === 'error')).toEqual([]);
    await expect(h.invoke('upload_pdf_ocr_page', { sessionId: id, page: pageInput(2) })).rejects.toEqual(SESSION_CLOSED);
    console.log('WP-138 total-pages raw', JSON.stringify(capture.trace));
  } finally { gate.resolve(); capture.stop(); }
});

it.each([false, true])('WP-138 Started emit failure warns before config, then preserves configFails=%s outcome', async (configFails) => {
  const fakes: Fakes = { calls: [], configFails, ocr: async (_p, idx) => [card('ok', idx)] };
  const h = await start(fakes);
  const capture = captureOcr(h);
  const attempted: unknown[] = [];
  const service = productionService(h, (payload) => {
    attempted.push(payload);
    if ((payload as Payload).type === 'Started') throw new Error('event transport closed');
    h.ctx.backendEvents.emit('pdf_ocr_progress', payload);
  });
  try {
    const [id, session] = await service.startSession(PDF_B64, null, 1);
    if (!configFails) await service.addPage(session.pageTx, id, pageInput(0));
    const done = await completed(h, id);
    expect(attempted[0]).toEqual({ type: 'Started', total_pages: 1, session_id: id });
    expect(capture.trace.filter((e) => e.kind === 'warn')).toEqual([
      { kind: 'warn', message: '[PDF-OCR] Emit error: event transport closed' },
    ]);
    expect(capture.trace[1]).toEqual({ kind: 'warn', message: '[PDF-OCR] Emit error: event transport closed' });
    expect(done).toEqual({ type: 'Completed', session_id: id, total_pages: 1,
      success_count: configFails ? 0 : 1, failed_count: configFails ? 1 : 0,
      has_failures: configFails, cancelled: false });
    expect(progress(h, id).map((e) => e.type)).toEqual([configFails ? 'PageFailed' : 'PageCompleted', 'Completed']);
    expect(fakes.calls.length).toBe(configFails ? 0 : 1);
    console.log('WP-138 Started-failure raw', JSON.stringify({ attempted, trace: capture.trace }));
  } finally { capture.stop(); }
});

it('WP-138 backend join_next keeps task panic separate from business PageFailed and waits for the surviving page', async () => {
  const failures = deferred();
  const survivor = deferred();
  const fakes: Fakes = { calls: [], ocr: async (_p, idx) => {
    await (idx === 2 ? survivor.promise : failures.promise);
    if (idx === 1) throw { error_type: 'LLM', message: 'bad request', details: { status: 400 } };
    return [idx === 0 ? panickingCard(idx) : card('survived', idx)];
  } };
  const h = await start(fakes);
  const capture = captureOcr(h);
  const pdfPath = path.join(root, 'join.pdf');
  fs.writeFileSync(pdfPath, 'backend-join');
  const id = await h.invoke<string>('start_pdf_ocr_backend', { pdfPath });
  try {
    await until(() => fakes.calls.length === 3, 'three backend OCR tasks');
    failures.resolve();
    await until(() => capture.trace.some((e) => e.kind === 'error'), 'backend task panic log');
    expect(capture.trace.filter((e) => e.kind === 'error')).toEqual([
      { kind: 'error', message: '[PdfOcrService] OCR task panicked: page task exploded' },
    ]);
    expect(progress(h, id).filter((e) => e.type === 'PageFailed')).toEqual([
      { type: 'PageFailed', session_id: id, page_index: 1, error: 'bad request' },
    ]);
    expect(progress(h, id).some((e) => e.type === 'Completed')).toBe(false);
    survivor.resolve();
    expect(await completed(h, id)).toEqual({ type: 'Completed', session_id: id, total_pages: 3,
      success_count: 1, failed_count: 1, ocr_failed_count: 1, render_failed_count: 0,
      render_failed_pages: [], has_failures: true, cancelled: false });
    const page = progress(h, id).find((e) => e.type === 'PageCompleted');
    expect(page).toEqual({ type: 'PageCompleted', session_id: id, page_index: 2, completed: 2, total: 3,
      cached: false, page_result: { page_index: 2, width: 1275, height: 1650,
        blocks: [{ text: 'survived', bbox: card('', 2).bbox }] } });
    const ordered = capture.trace.filter((e) => e.kind === 'error'
      || (e.kind === 'event' && ['PageCompleted', 'Completed'].includes(String((e.payload as Payload).type))));
    expect(ordered.map((e) => e.message ?? (e.payload as Payload).type)).toEqual([
      '[PdfOcrService] OCR task panicked: page task exploded', 'PageCompleted', 'Completed',
    ]);
    console.log('WP-138 backend raw', JSON.stringify(capture.trace));
  } finally {
    failures.resolve(); survivor.resolve();
    await until(() => progress(h, id).some((e) => e.type === 'PageCompleted'), 'backend survivor settled');
    capture.stop();
  }
});

it('WP-138 final drain retains already-finished panics and completes even when all page tasks fail', async () => {
  let panics = 0;
  const fakes: Fakes = { calls: [], ocr: async (_p, idx) => [panickingCard(idx, () => { panics += 1; })] };
  const h = await start(fakes);
  const capture = captureOcr(h);
  const service = productionService(h);
  const [id, session] = await service.startSession(PDF_B64, null, 3);
  try {
    for (const idx of [0, 1]) {
      await service.addPage(session.pageTx, id, pageInput(idx));
      await until(() => panics === idx + 1, 'page task panic before drain');
    }
    expect(capture.trace.filter((e) => e.kind === 'error')).toEqual([]);
    session.pageTx.close();
    expect(await completed(h, id)).toEqual({ type: 'Completed', session_id: id, total_pages: 3,
      success_count: 0, failed_count: 0, has_failures: false, cancelled: false });
    expect(capture.trace.filter((e) => e.kind === 'error')).toEqual([
      { kind: 'error', message: '[PdfOcrService] OCR task panicked: page task exploded' },
      { kind: 'error', message: '[PdfOcrService] OCR task panicked: page task exploded' },
    ]);
    expect(progress(h, id).map((e) => e.type)).toEqual(['Started', 'Completed']);
    await expect(service.addPage(session.pageTx, id, pageInput(2))).rejects.toMatchObject({ value: SESSION_CLOSED });
    console.log('WP-138 all-panics raw', JSON.stringify(capture.trace));
  } finally { session.pageTx.close(); capture.stop(); }
});

it('WP-138 cancel drains prior panic, retains completed page, suppresses late page and closes receiver', async () => {
  const late = deferred();
  const returned = deferred();
  let panicked = false;
  const fakes: Fakes = { calls: [], ocr: async (_p, idx) => {
    if (idx === 0) return [panickingCard(idx, () => { panicked = true; })];
    if (idx === 2) { await late.promise; returned.resolve(); }
    return [card('kept', idx)];
  } };
  const h = await start(fakes);
  const capture = captureOcr(h);
  const service = productionService(h);
  const [id, session] = await service.startSession(PDF_B64, null, 5);
  try {
    await service.addPage(session.pageTx, id, pageInput(0));
    await until(() => panicked, 'prior task panic');
    await service.addPage(session.pageTx, id, pageInput(1));
    await until(() => progress(h, id).some((e) => e.type === 'PageCompleted'), 'retained completed page');
    await service.addPage(session.pageTx, id, pageInput(2));
    await until(() => fakes.calls.length === 3, 'in-flight page');
    session.cancelTx.send(true);
    // Wake the actual recv; the worker checks cancel on its next loop, exactly as before this patch.
    await service.addPage(session.pageTx, id, pageInput(3));
    expect(await completed(h, id)).toEqual({ type: 'Completed', session_id: id, total_pages: 5,
      success_count: 1, failed_count: 0, has_failures: false, cancelled: true });
    expect(capture.trace.filter((e) => e.kind === 'error')).toEqual([
      { kind: 'error', message: '[PdfOcrService] OCR task panicked: page task exploded' },
    ]);
    const before = progress(h, id);
    expect(before.map((e) => [e.type, e.page_index])).toEqual([
      ['Started', undefined], ['PageCompleted', 1], ['Completed', undefined],
    ]);
    late.resolve();
    await returned.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(progress(h, id)).toEqual(before);
    expect(fakes.calls.map((c) => c[1])).toEqual([0, 1, 2]);
    await expect(service.addPage(session.pageTx, id, pageInput(4))).rejects.toMatchObject({ value: SESSION_CLOSED });
    console.log('WP-138 cancel raw', JSON.stringify(capture.trace));
  } finally { late.resolve(); session.pageTx.close(); capture.stop(); }
});

it('backend session: pause/resume/cancel go through the shared control maps', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const fakes: Fakes = { calls: [], pageCount: 30, ocr: async (_p, idx) => { await gate; return [card('x', idx)]; } };
  const h = await start(fakes);
  const pdfPath = path.join(root, 'in.pdf');
  fs.writeFileSync(pdfPath, 'pdf-cancel');
  const id = await h.invoke<string>('start_pdf_ocr_backend', { pdfPath });
  expect(await h.invoke('pause_pdf_ocr_session', { sessionId: id })).toBe(true);
  const deadline = Date.now() + 5000;
  while (!progress(h, id).some((e) => e.type === 'Paused')) {
    if (Date.now() > deadline) throw new Error('no Paused');
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(await h.invoke('resume_pdf_ocr_session', { sessionId: id })).toBe(true);
  expect(await h.invoke('cancel_pdf_ocr_session', { sessionId: id })).toBe(true);
  expect(await h.invoke('cancel_pdf_ocr_session', { sessionId: id })).toBe(false);
  release();
  const done = await completed(h, id);
  expect(done.cancelled).toBe(true);
  expect(done.total_pages).toBe(30);
  expect(done.render_failed_count).toBe(0);
}, 20_000);

it('backend session: config failure reports total_pages 0 and failed_count 1', async () => {
  const h = await start({ calls: [], ocr: async () => [], configFails: true });
  const pdfPath = path.join(root, 'in.pdf');
  fs.writeFileSync(pdfPath, 'x');
  const id = await h.invoke<string>('start_pdf_ocr_backend', { pdfPath, renderDpi: null });
  expect(await completed(h, id)).toEqual({ type: 'Completed', session_id: id, total_pages: 0, success_count: 0, failed_count: 1, has_failures: true, cancelled: false });
  await expect(h.invoke('start_pdf_ocr_backend', { pdfPath: path.join(root, 'missing.pdf') }))
    .rejects.toMatchObject({ error_type: 'FileSystem', message: expect.stringMatching(/^读取 PDF 文件失败: /) });
});

it('test_ocr_engine: L02 engine test, configured name, region bbox filtering, temp cleanup, failures', async () => {
  const fakes: Fakes = { calls: [], ocr: async () => [] };
  const h = await start(fakes);
  const ok = await h.invoke<Payload>('test_ocr_engine', { request: { imageBase64: `data:image/png;base64,${PNG_1x1}`, engineType: 'paddleocr-vl', configId: 'cfg-1' } });
  expect(ok).toMatchObject({
    engineType: 'paddle_ocr_vl', engineName: '我的 Paddle', text: '你好', success: true, error: null,
    regions: [{ text: '你好', bbox: [0.1, 0.2, 0.3, 0.4], label: 'text' }, { text: 'x', bbox: null, label: 'title' }],
  });
  expect(fakes.testCalls![0]!.slice(1)).toEqual(['paddle_ocr_vl', 'cfg-1']);
  expect(path.extname(fakes.testCalls![0]![0] as string)).toBe('.png');
  expect(fs.readdirSync(path.join(root, 'ocr_test_temp'))).toEqual([]);

  const failed = await h.invoke<Payload>('test_ocr_engine', { request: { imageBase64: PNG_1x1, engineType: 'deepseek', configId: 'bad' } });
  expect(failed).toMatchObject({ engineType: 'deepseek_ocr', engineName: 'DeepSeek-OCR', text: '', regions: [], success: false, error: '找不到配置 ID: bad' });

  // system_ocr goes to L01 performSystemOcr; with no native binding on linux it fails honestly.
  const system = await h.invoke<Payload>('test_ocr_engine', { request: { imageBase64: PNG_1x1, engineType: 'system_ocr' } });
  expect(system).toMatchObject({ engineType: 'system_ocr', engineName: 'system_ocr', text: '', regions: [], success: false });
  expect(system.error).toMatch(/^不支持的功能: /);
  expect(fakes.testCalls).toHaveLength(2);

  await expect(h.invoke('test_ocr_engine', { request: { imageBase64: 'data:image/png;base64', engineType: 'x' } }))
    .rejects.toEqual({ error_type: 'Validation', message: '图片解析失败: Invalid data URL format', details: null });
});

it('rate_limit_hint, render size, file name sanitizing and LRU budget follow Rust', async () => {
  expect(rateLimitHint({ message: 'x', details: { status: 429, retry_after_ms: 5 } })).toEqual([5, 'retry_after_ms']);
  expect(rateLimitHint({ message: 'x', details: { status: 429, retry_after_seconds: 2 } })).toEqual([2000, 'retry_after_seconds']);
  expect(rateLimitHint({ message: 'x', details: { status: 429 } })).toEqual([0, 'status']);
  expect(rateLimitHint({ message: 'Too Many Requests', details: null })).toEqual([0, 'message']);
  expect(rateLimitHint({ message: 'HTTP 503', details: { status: 503 } })).toBeNull();
  expect(renderSize(612, 792, 150)).toEqual({ width: 1275, height: 1650 });
  // Tall page hits maximum_height = dpi * 14.
  expect(renderSize(100, 1000, 150)).toEqual({ width: 210, height: 2100 });
  expect(sanitizePdfFileName(null)).toBe('document.pdf');
  expect(sanitizePdfFileName(' ._a b.PDF_ ')).toBe('a_b.PDF');
  expect(sanitizePdfFileName('报告')).toBe('document.pdf');

  const logs: string[] = [];
  const service = new PdfOcrService({
    appDataDir: () => root, imagesDir: () => path.join(root, 'images'), ocrModels: () => undefined,
    ocrPages: () => undefined, pdfium: () => undefined, image: () => undefined, emit: () => {},
    log: { info: () => {}, warn: (m) => logs.push(m), error: () => {} },
  });
  const cacheRoot = path.join(root, 'pdf_ocr_cache');
  for (const [name, age] of [['old', 3], ['mid', 2], ['keep', 1], ['new', 0]] as const) {
    fs.mkdirSync(path.join(cacheRoot, name), { recursive: true });
    fs.writeFileSync(path.join(cacheRoot, name, 'page_00000.json'), Buffer.alloc(100));
    const t = new Date(Date.now() - age * 60_000);
    fs.utimesSync(path.join(cacheRoot, name), t, t);
  }
  await service.enforceDirBudget('pdf_ocr_cache', [path.join(cacheRoot, 'keep'), path.join(root, 'missing')], 250, 150);
  // 300 bytes outside the keep set > 250: remove oldest-first until <= 150.
  expect(fs.readdirSync(cacheRoot).sort()).toEqual(['keep', 'new']);
  expect(logs.some((m) => m.startsWith('[PdfOcrService] canonicalize error for'))).toBe(true);
});

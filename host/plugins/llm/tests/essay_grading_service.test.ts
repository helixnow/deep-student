import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHost } from '../../../kernel/testing.ts';
import { gradingScoreToWire } from '../api.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { tokenizer } from '../../../platform/native/tokenizer/index.ts';
import { image } from '../../../platform/native/image/index.ts';
// boundary-allow cross-plugin-impl: integration test installs L11's real repository through its plugin entry
import repos from '../../vfs-repos/index.ts';
// boundary-allow cross-plugin-impl: integration test invokes L15's actual command consumer
import review from '../../review/index.ts';
import { OpenAIAdapter } from '../../llm-providers/api.ts';
import { createNodeFiles } from '../../../platform/files/index.ts';
import type * as Wire from '../../../../contracts/ipc/generated/L15-review-analytics.ts';
import llmPlugin from '../index.ts';
import { makeConfig } from './support.ts';
import { realInjectionBudget } from './host.ts';
import { createEssayTransport, type EssayStreamRequest } from '../src/essay_grading/transport.ts';

let host: Awaited<ReturnType<typeof createTestHost>>;
let storage: ReturnType<typeof createStorageService>;
let root: string;
let session: Wire.VfsEssaySession;
const config = makeConfig({ model: 'test-model', baseUrl: 'https://essay-provider.invalid/v1', apiProtocol: 'openai_chat_completions', enabled: true });
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'essay-service-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  expect((await storage.migrations.runAll()).success).toBe(true);
  const values = new Map<string, string>();
  host = await createTestHost({ plugins: [repos, llmPlugin, review], provide: {
    storage, nativeTokenizer: tokenizer, nativeImage: image, injectionBudget: realInjectionBudget, vfsDatabase: { getConnSafe: () => storage.database('vfs') },
    llmAdapters: { createAdapter: () => new OpenAIAdapter() },
    settings: { get: (key: string) => values.get(key) ?? null, save: (key: string, value: string) => values.set(key, value),
      getSecret: async () => null },
    secrets: { isEncryptedFormat: () => false },
    paths: { deviceId: async () => 'essay-integration-device', dataSpaceDeviceId: async () => 'essay-integration-device' },
    llmCodexAuth: { status: async () => ({ hasUsableSession: false }) },
    files: createNodeFiles({ roots: [{ name: 'temp', path: tmpdir() }] }),
    // vfs-repos 依赖 notes 仓储（仅笔记软删除/恢复/清除时使用），本测试不涉及笔记。
    'notes': {},
  } });
}, 120_000);
beforeEach(async () => {
  session = await host.invoke('essay_grading_create_session', { title: 'Essay service', essayType: 'other', gradeLevel: 'high_school' });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); host.events.length = 0; });
afterAll(async () => { await host?.dispose(); storage?.dispose(); if (root) rmSync(root, { recursive: true, force: true }); });

function request(id: string, round = 1): Wire.GradingRequest {
  return { session_id: session.id, stream_session_id: id, round_number: round,
    input_text: 'My hometown is beautiful.', essay_type: 'other', grade_level: 'high_school' };
}
function response(text: string, done = true): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n${done ? 'data: [DONE]\n\n' : ''}`,
    { headers: { 'content-type': 'text/event-stream' } });
}
function configureModel(): void {
  vi.spyOn(host.ctx.llm, 'getModel2Config').mockResolvedValue(config);
}

describe('essayGrading production provider → review commands → VFS', () => {
  it('filters GLM/Qwen wrappers before score parsing and persistence', async () => {
    vi.spyOn(host.ctx.llm, 'getModel2Config').mockResolvedValue({ ...config, model: 'Qwen3', providerType: 'qwen' });
    const text = '<score total="80" max="100"></score>';
    vi.stubGlobal('fetch', vi.fn(async () => response(`<|im_start|>assistant\n${text}<|im_end|>`)));
    const output = await host.invoke<Wire.GradingResponse>('essay_grading_stream', { request: request('wrap') });
    expect(output.grading_result).toBe(text);
    expect((await host.invoke<Wire.GradingRoundResponse>('essay_grading_get_round', { sessionId: session.id, roundNumber: 1 })).grading_result).toBe(text);
  });
  it('retries retryable HTTP errors before output but preserves fatal authentication errors', async () => {
    configureModel();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('limited', { status: 429 }))
      .mockResolvedValueOnce(response('<score total="80" max="100"></score>'));
    vi.stubGlobal('fetch', fetcher);
    await expect(host.invoke('essay_grading_stream', { request: request('retry', 5) })).resolves.toHaveProperty('round_id');
    expect(fetcher).toHaveBeenCalledTimes(2);
    const fatal = vi.fn(async () => new Response('bad key', { status: 401 }));
    vi.stubGlobal('fetch', fatal);
    await expect(host.invoke('essay_grading_stream', { request: request('auth', 6) }))
      .rejects.toMatchObject({ message: '批改 API 返回错误 401 Unauthorized: bad key', details: { category: 'auth', retryable: false } });
    expect(fatal).toHaveBeenCalledTimes(1);
  });

  it('idle timeout and explicit cancellation drop the pending body and clear the cancellation channel', async () => {
    for (const reason of ['timeout', 'cancel'] as const) {
      let closed = false;
      let entered!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        pull() { entered(); }, cancel() { closed = true; },
      })));
      const controller = new AbortController();
      const input: EssayStreamRequest = { config, apiKey: 'key', systemPrompt: 'Grade', userPrompt: 'Essay',
        streamEvent: `essay-test-${reason}`, essayImages: [], topicImages: [], signal: controller.signal };
      const stream = createEssayTransport(host.ctx.llm, () => new OpenAIAdapter(), fetcher, 25);
      const clear = vi.spyOn(host.ctx.llm, 'clearCancelStream');
      const operation = stream(input, () => { throw new Error('no chunks expected'); });
      if (reason === 'cancel') {
        await ready;
        controller.abort();
        await expect(operation).resolves.toBe('cancelled');
      } else await expect(operation).rejects.toMatchObject({ details: { code: 'ESSAY_STREAM_IDLE_TIMEOUT' } });
      expect(closed).toBe(true);
      expect(clear).toHaveBeenCalledWith(input.streamEvent);
      clear.mockRestore();
    }
  });

  it('provides modes and custom CRUD with Rust snake_case wire fields', async () => {
    expect(host.ctx.essayGrading).toBeDefined();
    const modes = await host.invoke<Wire.GradingMode[]>('essay_grading_get_modes');
    expect(modes.find(mode => mode.id === 'practice')?.is_builtin).toBe(true);
    const created = await host.invoke<Wire.GradingMode>('essay_grading_create_custom_mode', { input: {
      name: 'Integration rubric', description: '', system_prompt: 'Grade the essay fairly.',
      score_dimensions: [{ name: 'Content', max_score: 10 }], total_max_score: 10,
    } });
    expect(created.system_prompt).toBe('Grade the essay fairly.');
    expect(created.created_at).toMatch(/\+00:00$/);
    await host.invoke('essay_grading_delete_custom_mode', { modeId: created.id });
    expect(await host.invoke('essay_grading_get_mode', { modeId: created.id })).toBeNull();
  });

  it.each(['main', 'essay-secondary'])('streams from %s, commits, then broadcasts completion on the requested stream channel', async (label) => {
    configureModel();
    const text = '<score total="80" max="100"><dim name="内容" score="30" max="40">好</dim></score>';
    vi.stubGlobal('fetch', vi.fn(async () => response(text)));
    const channel = `essay_grading_stream_complete-${label}`;
    const caller = { window: label, webview: label };
    const received: unknown[] = [];
    const otherWindow: unknown[] = [];
    const unrelatedStream: unknown[] = [];
    const conn = storage.database('vfs');
    const exec = vi.spyOn(conn, 'exec');
    const completedState: unknown[] = [];
    const unlisten = [
      host.ctx.backendEvents.listenWindow(caller, channel, payload => {
        received.push(payload);
        if ((payload as { type: string }).type === 'complete') completedState.push({
          transaction: exec.mock.calls.at(-1)?.[0],
          rounds: conn.pluck<number>('SELECT total_rounds FROM essay_sessions WHERE id = ?1', [session.id]),
          essays: conn.pluck<number>('SELECT COUNT(*) FROM essays WHERE session_id = ?1', [session.id]),
        });
      }),
      host.ctx.backendEvents.listenWindow({ window: 'observer', webview: 'observer' }, channel, payload => otherWindow.push(payload)),
      host.ctx.backendEvents.listenWindow(caller, 'essay_grading_stream_unrelated', payload => unrelatedStream.push(payload)),
    ];
    let output: Wire.GradingResponse;
    try {
      output = await host.invoke<Wire.GradingResponse>('essay_grading_stream', { request: request(`complete-${label}`) }, caller);
    } finally { unlisten.forEach(dispose => dispose()); }
    expect(output.grading_result).toBe(text);
    const round = await host.invoke<Wire.GradingRoundResponse>('essay_grading_get_round', { sessionId: session.id, roundNumber: 1 });
    expect(round.id).toBe(output.round_id);
    expect(round.input_text).toBe('My hometown is beautiful.');
    expect(JSON.parse(round.dimension_scores_json!).dimensions[0]).toHaveProperty('max_score');
    expect((await host.invoke<Wire.VfsEssaySession>('essay_grading_get_session', { sessionId: session.id })).total_rounds).toBe(1);
    const events = host.events.filter(event => event.event === channel);
    expect(events.filter(event => (event.payload as { type: string }).type === 'complete')).toHaveLength(1);
    expect(events.at(-1)?.payload).toMatchObject({ type: 'complete', round_id: output.round_id });
    // Rust GradingEventEmitter uses Window::emit, not emit_to: source is not a target.
    // All windows receive the broadcast; stream_session_id selects the caller's channel.
    expect(events.every(event => event.target.kind === 'Any')).toBe(true);
    // Host listeners keep the f32 raw-JSON atom; outbound events carry its JSON value.
    expect(JSON.parse(JSON.stringify(received))).toEqual(events.map(event => event.payload));
    expect(otherWindow).toEqual(received);
    expect(unrelatedStream).toEqual([]);
    expect(received).toContainEqual({ type: 'data', chunk: text, char_count: Array.from(text).length });
    expect(completedState).toEqual([{ transaction: 'COMMIT', rounds: 1, essays: 1 }]);
  });

  it('rolls back the essay when session stats fail and emits error without completion', async () => {
    configureModel();
    vi.stubGlobal('fetch', vi.fn(async () => response('<score total="80" max="100"></score>')));
    const conn = storage.database('vfs');
    conn.exec(`CREATE TEMP TRIGGER fail_essay_stats BEFORE UPDATE OF total_rounds ON essay_sessions
      BEGIN SELECT RAISE(ABORT, 'essay stats failure'); END`);
    try {
      await expect(host.invoke('essay_grading_stream', { request: request('save-failure') }))
        .rejects.toMatchObject({ error_type: 'Database', message: expect.stringContaining('VFS 保存失败') });
    } finally { conn.exec('DROP TRIGGER fail_essay_stats'); }
    expect(await host.invoke('essay_grading_get_round', { sessionId: session.id, roundNumber: 1 })).toBeNull();
    expect((await host.invoke<Wire.VfsEssaySession>('essay_grading_get_session', { sessionId: session.id })).total_rounds).toBe(0);
    const events = host.eventsNamed('essay_grading_stream_save-failure');
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('essay stats failure') });
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'complete' }));
  });

  it('serializes overall_score as the shortest f32 repr in stream and get_round (serde f32)', async () => {
    configureModel();
    vi.stubGlobal('fetch', vi.fn(async () => response('<score total="85.3" max="100"></score>')));
    const output = await host.invoke<Wire.GradingResponse>('essay_grading_stream', { request: request('f32-round', 7) });
    expect(output.overall_score).toBe(85.3);
    const round = await host.invoke<Wire.GradingRoundResponse>('essay_grading_get_round', { sessionId: session.id, roundNumber: 7 });
    expect(round.overall_score).toBe(85.3);
    const summed = '<score total="60" max="100"><dim name="创意与表达" score="30" max="40">a</dim>'
      + '<dim name="内容完整" score="20.6" max="30">b</dim><dim name="语言规范" score="23.3" max="30">c</dim></score>';
    vi.stubGlobal('fetch', vi.fn(async () => response(summed)));
    const sumOutput = await host.invoke<Wire.GradingResponse>('essay_grading_stream', { request: request('f32-sum', 8) });
    expect(sumOutput.overall_score).toBe(73.899994);
    expect(host.eventsNamed('essay_grading_stream_f32-sum').at(-1)).toMatchObject({ type: 'complete', overall_score: 73.899994 });
    const sumRound = await host.invoke<Wire.GradingRoundResponse>('essay_grading_get_round', { sessionId: session.id, roundNumber: 8 });
    expect(sumRound.overall_score).toBe(73.899994);
    expect(JSON.parse(sumRound.dimension_scores_json!).total).toBe(73.899994);
  });

  it('overall_score leaves the complete event in serde f32 spelling (52.0); gradingScoreToWire spells the replies', async () => {
    configureModel();
    vi.stubGlobal('fetch', vi.fn(async () => response('<score total="52" max="100"></score>')));
    const reply = await host.runtime.dispatchInvoke({ id: 'essay-wire-1', cmd: 'essay_grading_stream',
      args: { request: request('f32-wire', 10) }, source: { window: 'main', webview: 'main' } });
    expect(reply.kind).toBe('ok');
    const complete = host.events.filter(event => event.event === 'essay_grading_stream_f32-wire').at(-1);
    expect(complete?.payloadJson).toContain('"overall_score":52.0,');
    const stored = await host.invoke<Wire.GradingRoundResponse>('essay_grading_get_round', { sessionId: session.id, roundNumber: 10 });
    expect(stored.overall_score).toBe(52);
    expect(JSON.stringify(gradingScoreToWire(stored))).toContain('"overall_score":52.0,');
    expect(gradingScoreToWire({ ...stored, overall_score: null }).overall_score).toBeNull();
    expect(gradingScoreToWire(null)).toBeNull();
  });

  it('writes dimension_scores_json / grading_result_json with Rust f32 spelling (serde #3, #7)', async () => {
    configureModel();
    const text = '<score total="80" max="100"><dim name="内容" score="30" max="40">好</dim></score>';
    vi.stubGlobal('fetch', vi.fn(async () => response(text)));
    const output = await host.invoke<Wire.GradingResponse>('essay_grading_stream', { request: request('serde-spelling', 9) });
    const conn = storage.database('vfs');
    const dimensions = conn.pluck<string>('SELECT dimension_scores_json FROM essays WHERE id = ?1', [output.round_id])!;
    const grading = conn.pluck<string>('SELECT grading_result_json FROM essays WHERE id = ?1', [output.round_id])!;
    // dstu-tutor essay_grading/types.rs:44 ParsedScore { total: f32, max_total: f32, grade, dimensions: [DimensionScore] }
    const parsed = JSON.parse(dimensions) as { grade: string };
    const parsedScoreJson = `{"total":80.0,"max_total":100.0,"grade":${JSON.stringify(parsed.grade)},`
      + '"dimensions":[{"name":"内容","score":30.0,"max_score":40.0,"comment":"好"}]}';
    expect(dimensions).toBe(parsedScoreJson);
    // pipeline.rs:525 json!({"result", "overall_score": Option<f32>, "dimension_scores": parsed_score_json})
    expect(grading).toBe(`{"result":${JSON.stringify(text)},"overall_score":80.0,"dimension_scores":${JSON.stringify(parsedScoreJson)}}`);
    expect(output.dimension_scores_json).toBe(parsedScoreJson);
    expect(host.eventsNamed('essay_grading_stream_serde-spelling').at(-1)).toMatchObject({ type: 'complete', parsed_score: parsedScoreJson });
    const round = await host.invoke<Wire.GradingRoundResponse>('essay_grading_get_round', { sessionId: session.id, roundNumber: 9 });
    // essay_grading/mod.rs:118 re-serializes the stored Value; arbitrary_precision keeps `80.0`.
    expect(round.dimension_scores_json).toBe(parsedScoreJson);
  });

  it('rejects incomplete output with partial_chars and releases the stream guard', async () => {
    configureModel();
    vi.stubGlobal('fetch', vi.fn(async () => response('partial', false)));
    await expect(host.invoke('essay_grading_stream', { request: request('incomplete', 2) }))
      .rejects.toMatchObject({ details: { code: 'ESSAY_STREAM_INCOMPLETE' } });
    expect(host.eventsNamed('essay_grading_stream_incomplete').at(-1)).toMatchObject({ type: 'error', partial_chars: 7 });
    expect(await host.invoke('essay_grading_get_round', { sessionId: session.id, roundNumber: 2 })).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => response('<score total="80" max="100"></score>', false)));
    await expect(host.invoke('essay_grading_stream', { request: request('incomplete', 2) })).resolves.toHaveProperty('round_id');
  });

  it('does not write a ghost round after cancellation between completion and save', async () => {
    configureModel();
    let calls = 0;
    vi.spyOn(host.ctx.llm, 'consumePendingCancel').mockImplementation(async () => ++calls === 3);
    vi.stubGlobal('fetch', vi.fn(async () => response('<score total="80" max="100"></score>')));
    await expect(host.invoke('essay_grading_stream', { request: request('cancel-save', 3) })).resolves.toBeNull();
    expect(await host.invoke('essay_grading_get_round', { sessionId: session.id, roundNumber: 3 })).toBeNull();
    expect(host.eventsNamed('essay_grading_stream_cancel-save').at(-1)).toEqual({ type: 'cancelled' });
  });

  it('validates modes with dual-channel errors and rejects duplicate streams without poisoning the active stream', async () => {
    configureModel();
    await expect(host.invoke('essay_grading_stream', { request: { ...request('bad-mode'), mode_id: 'missing' } }))
      .rejects.toMatchObject({ details: { code: 'ESSAY_MODE_NOT_FOUND' } });
    expect(host.eventsNamed('essay_grading_stream_bad-mode').at(-1)).toMatchObject({ type: 'error', code: 'ESSAY_MODE_NOT_FOUND' });
    let release!: (value: Response) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => { started(); return new Promise<Response>(resolve => { release = resolve; }); }));
    const first = host.invoke('essay_grading_stream', { request: request('exclusive', 4) });
    await ready;
    await expect(host.invoke('essay_grading_stream', { request: request('exclusive', 4) }))
      .rejects.toMatchObject({ details: { code: 'ESSAY_STREAM_ALREADY_ACTIVE' } });
    expect(host.eventsNamed('essay_grading_stream_exclusive')).not.toContainEqual(expect.objectContaining({ type: 'error' }));
    release(response('<score total="80" max="100"></score>'));
    await first;
  });

  it('search filters before pagination and round validation preserves errors', async () => {
    await host.invoke('essay_grading_create_session', { title: 'Unique Needle', essayType: 'argumentative', gradeLevel: 'college' });
    const found = await host.invoke<Wire.VfsEssaySession[]>('essay_grading_list_sessions', { query: 'NEEDLE', limit: 1 });
    expect(found.map(item => item.title)).toEqual(['Unique Needle']);
    await expect(host.invoke('essay_grading_get_round', { sessionId: session.id, roundNumber: 0 }))
      .rejects.toMatchObject({ error_type: 'Validation', message: 'round_number 必须 >= 1 (收到 0)' });
    await expect(host.invoke('essay_grading_toggle_favorite', { sessionId: 'missing' }))
      .rejects.toMatchObject({ error_type: 'NotFound' });
  });
});

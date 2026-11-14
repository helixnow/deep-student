/**
 * llm-replay（D4）：可挂载的确定性 LLM 回放 provider。这里测它自身的行为与失败路径；与 G3 模拟服务逐字节
 * 对拍、以及经真实聊天管线的端到端对比在 host/e2e/streaming/wave0/llm-replay.test.ts。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createTestHost } from '../../../kernel/testing.ts';
import {
  LLM_REPLAY_ORIGIN, LLM_REPLAY_SCRIPTS, createLlmReplay, isLlmReplayUrl, llmReplayPlugin, providerSidecarScripts, validateReplayScripts,
  type LlmReplayService, type ReplayScript,
} from '../api.ts';

const SCRIPTS = {
  answer: { description: 'two chunks then [DONE]', rounds: [{ kind: 'sse', end: 'done', frames: [
    { content: '固定' }, { content: '回答' }, { finish: 'stop' }, { usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }] }] },
  tool: { description: 'round 0 calls the first offered tool, round 1 answers', rounds: [
    { kind: 'sse', end: 'done', frames: [{ reasoning: '想' }, { toolCall: { id: 'call_1', arguments: '{"q":1}' } }, { finish: 'tool_calls' }] },
    { kind: 'sse', end: 'done', frames: [{ content: 'ok' }, { finish: 'stop' }] },
  ] },
  named: { description: 'explicitly named tool', rounds: [{ kind: 'sse', end: 'eof', frames: [{ toolCall: { id: 'c', arguments: '{}', name: 'fixed_tool' } }] }] },
  hold: { description: 'one chunk, then open until the client closes', rounds: [{ kind: 'sse', end: 'hold', frames: [{ content: '部分' }] }] },
  http500: { description: 'HTTP 500 before any byte', rounds: [{ kind: 'http-error', status: 500, body: '{"error":{"message":"boom"}}' }] },
} satisfies Record<string, ReplayScript>;

const SIDECAR = {
  note: 'owner metadata',
  graded: [
    { status: 200, headers: { 'content-type': 'text/event-stream' }, chunks: ['data: {"choices":[{"delta":{"content":"A"}}]}\n\n', 'data: [DONE]\n\n'] },
    { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' }, chunks: ['{"error":', '"slow"}'] },
  ],
};

const instances: LlmReplayService[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const replay of instances.splice(0)) await replay.stop();
});
function replayOf(config: Parameters<typeof createLlmReplay>[0] = { scripts: SCRIPTS }) {
  const replay = createLlmReplay(config);
  instances.push(replay);
  return replay;
}
const endpoint = (replay: LlmReplayService, id: string) => `${replay.baseUrl(id)}/chat/completions`;
function post(replay: LlmReplayService, id: string, body: unknown, init: RequestInit = {}) {
  return replay.fetch(endpoint(replay, id), { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-replay' },
    body: typeof body === 'string' ? body : JSON.stringify(body), ...init });
}
const chunkJson = (model: string, delta: unknown, finish: string | null) =>
  JSON.stringify({ id: 'chatcmpl-x5-fixed', object: 'chat.completion.chunk', created: 1_700_000_000, model, choices: [{ index: 0, delta, finish_reason: finish }] });
const user = { role: 'user', content: 'hi' };
const toolTurn = { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] };
const tools = [{ type: 'function', function: { name: 'lookup', parameters: {} } }];

describe('llm-replay provider', () => {
  it('llm-replay: streams a round script as fixed OpenAI chat chunks and logs the served request', async () => {
    const replay = replayOf();
    const response = await post(replay, 'answer', { model: 'm1', stream: true, messages: [user] });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toBe([
      `data: ${chunkJson('m1', { content: '固定' }, null)}\n\n`,
      `data: ${chunkJson('m1', { content: '回答' }, null)}\n\n`,
      `data: ${chunkJson('m1', {}, 'stop')}\n\n`,
      `data: ${JSON.stringify({ id: 'chatcmpl-x5-fixed', object: 'chat.completion.chunk', created: 1_700_000_000, model: 'm1', choices: [],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''));
    expect(replay.requests).toEqual([{ seq: 0, method: 'POST', path: '/s/answer/v1/chat/completions', scriptId: 'answer', round: 0,
      stream: true, body: { model: 'm1', stream: true, messages: [user] }, outcome: 'served', status: 200, framesWritten: 4, end: 'done' }]);
    expect(replay.openCount()).toBe(0);
    expect(await replay.whenIdle(0)).toBe(true);
    expect(replay.url).toBe(LLM_REPLAY_ORIGIN);
  });

  it('llm-replay: chunks reach the reader one macrotask at a time, not all at once', async () => {
    const replay = replayOf();
    const reader = (await post(replay, 'answer', { model: 'm', stream: true, messages: [user] })).body!.getReader();
    const decoder = new TextDecoder();
    const reads: string[] = [];
    for (let next = await reader.read(); !next.done; next = await reader.read()) reads.push(decoder.decode(next.value));
    expect(reads).toHaveLength(5);
    expect(reads.at(-1)).toBe('data: [DONE]\n\n');
  });

  it('llm-replay: the round follows tool results in the request body; past the last round is an explicit 409', async () => {
    const replay = replayOf();
    const first = await post(replay, 'tool', { model: 'm', stream: true, tools, messages: [user] });
    const text = await first.text();
    expect(text).toContain(chunkJson('m', { reasoning_content: '想' }, null));
    expect(text).toContain(chunkJson('m', { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } }] }, null));
    const second = await post(replay, 'tool', { model: 'm', stream: true, tools, messages: [user, toolTurn, { role: 'tool', tool_call_id: 'call_1', content: 'r' }] });
    expect(await second.text()).toContain(chunkJson('m', { content: 'ok' }, null));
    // A new user turn resets the count.
    const again = await post(replay, 'tool', { model: 'm', stream: true, tools, messages: [user, toolTurn, { role: 'tool', content: 'r' }, user] });
    expect(await again.text()).toContain('call_1');
    const past = await post(replay, 'tool', { model: 'm', stream: true, tools, messages: [user, toolTurn, toolTurn] });
    expect(past.status).toBe(409);
    expect(await past.json()).toEqual({ error: { message: 'x5 llm service: script tool has no round 2', type: 'x5_llm_service' } });
    expect(replay.requests.map(r => [r.round, r.outcome, r.status, r.end])).toEqual([
      [0, 'served', 200, 'done'], [1, 'served', 200, 'done'], [0, 'served', 200, 'done'], [2, 'unscripted-round', 409, 'http-error']]);
  });

  it('llm-replay: an unnamed tool call without offered tools is a 400; an explicitly named one needs none', async () => {
    const replay = replayOf();
    const refused = await post(replay, 'tool', { model: 'm', stream: true, messages: [user] });
    expect(refused.status).toBe(400);
    expect((await refused.json() as { error: { message: string } }).error.message)
      .toBe('x5 llm service: script tool round 0 needs a tool but the request offered none');
    const named = await post(replay, 'named', { model: 'm', stream: true, messages: [user] });
    expect(await named.text()).toBe(`data: ${chunkJson('m', { tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'fixed_tool', arguments: '{}' } }] }, null)}\n\n`);
    expect(replay.requests.map(r => [r.outcome, r.end])).toEqual([['no-tool-offered', 'http-error'], ['served', 'eof']]);
  });

  it('llm-replay: non-stream requests get the same round folded into one completion', async () => {
    const replay = replayOf();
    const response = await post(replay, 'tool', { model: 'm', tools, messages: [user] });
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ id: 'chatcmpl-x5-fixed', object: 'chat.completion', created: 1_700_000_000, model: 'm', choices: [{
      index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', reasoning_content: '想',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } }] } }] });
    expect(replay.requests[0]).toMatchObject({ stream: false, outcome: 'served', end: 'done', framesWritten: 0 });
  });

  it('llm-replay: provider sidecar responses are verbatim, in arrival order, per instance; exhaustion is 409', async () => {
    const scripts = providerSidecarScripts(SIDECAR);
    expect(Object.keys(scripts)).toEqual(['graded']);
    const [one, two] = [replayOf({ scripts: {}, extraScripts: scripts }), replayOf({ scripts: {}, extraScripts: scripts })];
    for (const replay of [one, two]) {
      const ok = await post(replay, 'graded', '{"stream":true}');
      expect([ok.status, ok.headers.get('content-type'), await ok.text()])
        .toEqual([200, 'text/event-stream', SIDECAR.graded[0]!.chunks.join('')]);
      const slow = await post(replay, 'graded', '{"stream":false}');
      expect([slow.status, slow.headers.get('retry-after'), await slow.text()]).toEqual([429, '0', '{"error":"slow"}']);
    }
    const exhausted = await post(one, 'graded', '{}');
    expect(exhausted.status).toBe(409);
    expect(one.requests.map(r => [r.round, r.outcome, r.status, r.end, r.framesWritten])).toEqual([
      [0, 'served', 200, 'eof', 2], [1, 'served', 429, 'http-error', 2], [2, 'unscripted-round', 409, 'http-error', 0]]);
    expect(one.requests[0]!.raw).toEqual({ requestBody: '{"stream":true}',
      requestHeaders: ['authorization', 'Bearer sk-replay', 'content-type', 'application/json'],
      responseHeaders: { 'content-type': 'text/event-stream' }, chunks: SIDECAR.graded[0]!.chunks });
    expect(two.requests).toHaveLength(2);
  });

  it('llm-replay: failure paths answer like the HTTP service and are all logged', async () => {
    const replay = replayOf();
    const get = await replay.fetch(endpoint(replay, 'answer'));
    const other = await replay.fetch(`${LLM_REPLAY_ORIGIN}/s/answer/v1/completions`, { method: 'POST', body: '{}' });
    const unknown = await post(replay, 'missing', { stream: true });
    const badJson = await post(replay, 'answer', '{not json');
    const upstream = await post(replay, 'http500', { stream: true, messages: [user] });
    expect(await Promise.all([get, other, unknown, badJson].map(async r => [r.status, await r.json()]))).toEqual([
      [404, { error: { message: 'x5 llm service: no route for GET /s/answer/v1/chat/completions', type: 'x5_llm_service' } }],
      [404, { error: { message: 'x5 llm service: no route for POST /s/answer/v1/completions', type: 'x5_llm_service' } }],
      [404, { error: { message: 'x5 llm service: unknown script missing', type: 'x5_llm_service' } }],
      [400, { error: { message: 'x5 llm service: request body is not JSON', type: 'x5_llm_service' } }],
    ]);
    expect([upstream.status, await upstream.text()]).toEqual([500, '{"error":{"message":"boom"}}']);
    expect(replay.requests.map(r => [r.method, r.scriptId, r.outcome, r.status, r.end])).toEqual([
      ['GET', null, 'not-found', 404, 'http-error'], ['POST', null, 'not-found', 404, 'http-error'],
      ['POST', 'missing', 'unknown-script', 404, 'http-error'], ['POST', 'answer', 'bad-json', 400, 'http-error'],
      ['POST', 'http500', 'served', 500, 'http-error']]);
    expect(replay.requests[3]!.body).toBe('{not json');
  });

  it('llm-replay: a held stream stays open until the client aborts (client-closed)', async () => {
    const replay = replayOf();
    const controller = new AbortController();
    const reader = (await post(replay, 'hold', { model: 'm', stream: true, messages: [user] }, { signal: controller.signal })).body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(`data: ${chunkJson('m', { content: '部分' }, null)}\n\n`);
    const pending = reader.read();
    expect(replay.openCount()).toBe(1);
    expect(await replay.whenIdle(20)).toBe(false);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(replay.requests[0]).toMatchObject({ outcome: 'served', framesWritten: 1, end: 'client-closed' });
    expect(replay.openCount()).toBe(0);
    expect(await replay.whenIdle(0)).toBe(true);
  });

  it('llm-replay: cancelling the body of a held stream also closes it', async () => {
    const replay = replayOf();
    const response = await post(replay, 'hold', { stream: true, messages: [user] });
    await response.body!.cancel();
    expect(replay.requests[0]!.end).toBe('client-closed');
    expect(replay.openCount()).toBe(0);
  });

  it('llm-replay: aborting after a finished stream keeps its logged end', async () => {
    const replay = replayOf();
    const controller = new AbortController();
    const response = await post(replay, 'answer', { stream: true, messages: [user] }, { signal: controller.signal });
    expect(replay.requests[0]!.end).toBe('done');
    controller.abort();
    await expect(response.text()).rejects.toMatchObject({ name: 'AbortError' });
    expect(replay.requests[0]!.end).toBe('done');
  });

  it('llm-replay: an already aborted request is rejected before anything is logged', async () => {
    const replay = replayOf();
    const controller = new AbortController();
    controller.abort();
    await expect(post(replay, 'answer', { stream: true }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(replay.requests).toEqual([]);
  });

  it('llm-replay: stop() terminates open streams (server-stopped) and later requests fail as network errors, unlogged', async () => {
    const replay = replayOf();
    const reader = (await post(replay, 'hold', { stream: true, messages: [user] })).body!.getReader();
    await reader.read();
    const pending = reader.read();
    await replay.stop();
    await expect(pending).rejects.toThrow('terminated');
    expect(replay.requests[0]!.end).toBe('server-stopped');
    await expect(post(replay, 'answer', { stream: true })).rejects.toThrow(TypeError);
    expect(replay.requests).toHaveLength(1);
  });

  it('llm-replay: an internal failure is a network error and never falls through to another transport', async () => {
    const replay = replayOf();
    const error = await replay.fetch(`${LLM_REPLAY_ORIGIN}/s/%E0%A4%A/v1/chat/completions`, { method: 'POST', body: '{}' })
      .then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe('fetch failed');
    expect((error as TypeError).cause).toBeInstanceOf(URIError);
    // Same two log entries the HTTP service leaves: the admitted request, then the service error.
    expect(replay.requests.map(r => [r.seq, r.path, r.outcome, r.status])).toEqual([
      [0, '/s/%E0%A4%A/v1/chat/completions', 'not-found', 404], [1, '/s/%E0%A4%A/v1/chat/completions', 'service-error', 500]]);
  });

  it('llm-replay: fake timers in a test do not stall replayed streams', async () => {
    const replay = replayOf();
    vi.useFakeTimers();
    const response = await post(replay, 'answer', { stream: true, messages: [user] });
    expect(await response.text()).toContain('data: [DONE]');
  });

  it('llm-replay: invalid scripts fail when the provider is created, not at request time', () => {
    const sse = (frames: unknown[]) => ({ x: { description: 'd', rounds: [{ kind: 'sse', end: 'done', frames }] } });
    const cases: Array<[unknown, string]> = [
      [null, 'scripts must be an object'],
      [{ x: { rounds: [] } }, 'x needs a description'],
      [{ x: { description: 'd', rounds: [] } }, 'x needs rounds'],
      [{ x: { description: 'd', responses: [] } }, 'x needs responses'],
      [{ x: { description: 'd', rounds: [], responses: [] } }, 'exactly one of rounds / responses'],
      [sse([{ content: 'a', reasoning: 'b' }]), 'invalid round scripts.x[0]'],
      [sse([{ finish: 'end_turn' }]), 'invalid round scripts.x[0]'],
      [sse([{ toolCall: { id: 'c' } }]), 'invalid round scripts.x[0]'],
      [sse([{ usage: { prompt_tokens: -1, completion_tokens: 0, total_tokens: 0 } }]), 'invalid round scripts.x[0]'],
      [{ x: { description: 'd', rounds: [{ kind: 'sse', end: 'later', frames: [] }] } }, 'invalid round scripts.x[0]'],
      [{ x: { description: 'd', rounds: [{ kind: 'http-error', status: 700, body: '' }] } }, 'invalid round scripts.x[0]'],
      [{ x: { description: 'd', responses: [{ status: 200, headers: { a: 1 }, chunks: [] }] } }, 'invalid response scripts.x[0]'],
      [{ x: { description: 'd', responses: [{ status: 204, headers: {}, chunks: ['body'] }] } }, 'invalid response scripts.x[0]'],
      [sse([{ toolCall: { id: 'c', arguments: '{}', index: -1 } }]), 'invalid round scripts.x[0]'],
      [{ x: { description: 'd', derive: 'later' } }, 'x derive must be a function'],
      [{ x: { description: 'd', rounds: [], derive: () => null } }, 'exactly one of rounds / responses / derive'],
    ];
    for (const [scripts, message] of cases) expect(() => createLlmReplay({ scripts: scripts as never }), message).toThrow(message);
    expect(() => createLlmReplay({ scripts: SCRIPTS, extraScripts: { answer: SCRIPTS.answer } })).toThrow('extra script answer shadows a script');
    expect(() => providerSidecarScripts([])).toThrow('expected an object');
    expect(() => providerSidecarScripts({ a: [] })).toThrow('a needs responses');
    expect(() => providerSidecarScripts({ a: [{ status: 100, headers: {}, chunks: [] }] })).toThrow('invalid response a[0]');
    expect(() => providerSidecarScripts({ note: 1 })).toThrow('note needs responses');
  });

  it('llm-replay: scripts are copied at creation; later edits to the source do not leak in', async () => {
    const source = structuredClone(SCRIPTS) as Record<string, ReplayScript>;
    const replay = replayOf({ scripts: source });
    ((source.answer as { rounds: Array<{ frames: unknown[] }> }).rounds[0]!.frames).splice(0);
    expect(await (await post(replay, 'answer', { stream: true, messages: [user] })).text()).toContain('固定');
    expect(validateReplayScripts(source).answer).not.toBe(source.answer);
  });

  it('llm-replay: isLlmReplayUrl matches only the replay origin', () => {
    expect(isLlmReplayUrl(`${LLM_REPLAY_ORIGIN}/s/a/v1/chat/completions`)).toBe(true);
    expect(isLlmReplayUrl(new URL('HTTP://LLM-REPLAY.INVALID/x'))).toBe(true);
    expect(isLlmReplayUrl(new Request(`${LLM_REPLAY_ORIGIN}/s/a/v1`))).toBe(true);
    for (const other of ['https://llm-replay.invalid/x', 'http://llm-replay.invalid.example.com/x', 'http://127.0.0.1:9/s/a/v1',
      'http://example.com/?u=http://llm-replay.invalid/', 'not a url']) expect(isLlmReplayUrl(other), other).toBe(false);
  });

  it('llm-replay: the mounted plugin provides llmReplay from its config and stops open streams on dispose', async () => {
    const host = await createTestHost({ plugins: [[llmReplayPlugin, { scripts: SCRIPTS }]] });
    let replay: LlmReplayService;
    try {
      replay = host.ctx.llmReplay;
      expect(replay.baseUrl('a b')).toBe(`${LLM_REPLAY_ORIGIN}/s/a%20b/v1`);
      await (await post(replay, 'hold', { stream: true, messages: [user] })).body!.getReader().read();
      expect(replay.openCount()).toBe(1);
    } finally {
      await host.dispose();
    }
    expect(replay.requests[0]!.end).toBe('server-stopped');
    await expect(createTestHost({ plugins: [[llmReplayPlugin, { scripts: { x: { description: 'd', rounds: [] } } }]] }))
      .rejects.toThrow('x needs rounds');
  });
});

/** 16 kHz 单声道 16 位 PCM，6400 字节数据 = 200 ms。 */
function wav() {
  const out = new Uint8Array(44 + 6400);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, 36 + 6400, true);
  out.set(new TextEncoder().encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  out.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, 6400, true);
  return out;
}
function form(fields: Record<string, string>, file: ReturnType<typeof wav> | null = wav()): FormData {
  const data = new FormData();
  if (file) data.append('file', new Blob([file], { type: 'audio/wav' }), 'a.wav');
  for (const [name, value] of Object.entries(fields)) data.append(name, value);
  return data;
}
const transcribe = (replay: LlmReplayService, id: string, body: BodyInit, headers?: Record<string, string>) =>
  replay.fetch(`${replay.baseUrl(id)}/audio/transcriptions`, { method: 'POST', body, ...(headers ? { headers } : {}) });
const embed = (replay: LlmReplayService, id: string, body: unknown) =>
  replay.fetch(`${replay.baseUrl(id)}/embeddings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const directive = (rounds: unknown[], final = 'W0_DONE') => `W0_DIRECTIVE ${JSON.stringify({ v: 1, rounds, final })}`;

describe('llm-replay embeddings, transcriptions and derived scripts', () => {
  it('llm-replay: without scripts it serves the built-in table, w0.directive included', async () => {
    const replay = replayOf({});
    expect(await (await post(replay, 'success.answer', { model: 'm', stream: true, messages: [user] })).text()).toContain(chunkJson('m', { content: '固定' }, null));
    expect(await (await post(replay, 'w0.directive', { model: 'm', messages: [{ role: 'user', content: directive([]) }] })).json())
      .toMatchObject({ choices: [{ message: { role: 'assistant', content: 'W0_DONE' }, finish_reason: 'stop' }] });
    expect(validateReplayScripts(LLM_REPLAY_SCRIPTS)).toHaveProperty(['w0.directive', 'derive']);
  });

  it('llm-replay: embeddings answer from the body alone, for any script id, and log stream=false', async () => {
    const replay = replayOf({});
    const response = await embed(replay, 'no.such.script', { model: 'w0-text-embedding', input: ['导数', '光合作用'], dimensions: 8 });
    expect([response.status, response.headers.get('content-type')]).toEqual([200, 'application/json']);
    const json = await response.json() as { data: Array<{ index: number; embedding: number[] }>; usage: unknown; model: string };
    expect(json.model).toBe('w0-text-embedding');
    expect(json.data.map(item => [item.index, item.embedding.length])).toEqual([[0, 8], [1, 8]]);
    expect(json.data[0]!.embedding.reduce((sum, n) => sum + n, 0)).toBe(1 + 2 + 1);
    expect(json.usage).toEqual({ prompt_tokens: 6, total_tokens: 6 });
    const again = await embed(replay, 'success.answer', { model: 'w0-text-embedding', input: '导数', dimensions: 8 });
    expect((await again.json() as typeof json).data[0]!.embedding).toEqual(json.data[0]!.embedding);
    expect(replay.requests.map(r => [r.scriptId, r.round, r.stream, r.outcome, r.status, r.end])).toEqual([
      ['no.such.script', null, false, 'served', 200, 'done'], ['success.answer', null, false, 'served', 200, 'done']]);
  });

  it('llm-replay: embedding failures are explicit: unknown model 404, bad request 400, an http-error round 0 wins', async () => {
    const replay = replayOf({});
    const unknown = await embed(replay, 'x', { model: 'text-embedding-3-small', input: 'a' });
    const bad = await embed(replay, 'x', { model: 'w0-vl-embedding', input: [{ text: 'a', audio: 'b' }] });
    const dims = await embed(replay, 'x', { model: 'w0-text-embedding', input: 'a', dimensions: 769 });
    const upstream = await embed(replay, 'error.http-500', { model: 'w0-text-embedding', input: 'a' });
    expect(await Promise.all([unknown, bad, dims].map(async r => [r.status, ((await r.json()) as { error: { message: string } }).error.message]))).toEqual([
      [404, 'x5 llm service: unknown embedding model text-embedding-3-small (known: w0-text-embedding, w0-vl-embedding)'],
      [400, 'x5 llm service: input[0] has unsupported keys audio'],
      [400, 'x5 llm service: dimensions must be an integer in 1..768 for w0-text-embedding'],
    ]);
    expect([upstream.status, await upstream.text()]).toEqual([500, (LLM_REPLAY_SCRIPTS['error.http-500'].rounds[0] as { body: string }).body]);
    expect(replay.requests.map(r => [r.outcome, r.status, r.round])).toEqual([
      ['unknown-embedding-model', 404, null], ['bad-embedding-request', 400, null], ['bad-embedding-request', 400, null], ['served', 500, 0]]);
  });

  it('llm-replay: transcriptions answer round 0 text in every response_format and log the decoded form', async () => {
    const replay = replayOf({});
    const json = await transcribe(replay, 'success.answer', form({ model: 'whisper-1', language: 'zh' }));
    const text = await transcribe(replay, 'success.answer', form({ model: 'whisper-1', response_format: 'text' }));
    const verbose = await transcribe(replay, 'success.answer', form({ model: 'whisper-1', language: 'zh', response_format: 'verbose_json' }));
    const empty = await transcribe(replay, 'success.empty', form({ model: 'whisper-1', response_format: 'verbose_json' }));
    expect([json.status, json.headers.get('content-type'), await json.text()]).toEqual([200, 'application/json', '{"text":"固定回答"}']);
    expect([text.headers.get('content-type'), await text.text()]).toEqual(['text/plain; charset=utf-8', '固定回答']);
    expect(await verbose.json()).toEqual({ task: 'transcribe', language: 'zh', duration: 0.2, text: '固定回答',
      segments: [{ id: 0, seek: 0, start: 0, end: 0.2, text: '固定回答' }] });
    expect(await empty.json()).toEqual({ task: 'transcribe', language: 'unknown', duration: 0.2, text: '', segments: [] });
    const sha256 = createHash('sha256').update(wav()).digest('hex');
    expect(replay.requests[0]).toEqual({ seq: 0, method: 'POST', path: '/s/success.answer/v1/audio/transcriptions', scriptId: 'success.answer',
      round: 0, stream: false, body: { parts: [{ name: 'file', filename: 'a.wav', contentType: 'audio/wav', size: 6444, sha256 },
        { name: 'model', value: 'whisper-1' }, { name: 'language', value: 'zh' }] },
      outcome: 'served', status: 200, framesWritten: 0, end: 'done' });
  });

  it('llm-replay: transcription failures match the service rules', async () => {
    const replay = replayOf({ extraScripts: providerSidecarScripts({ asr: [{ status: 200, headers: { 'content-type': 'application/json' }, chunks: ['{"text":"旁车"}'] }] }) });
    const cases: Array<[string, BodyInit, Record<string, string> | undefined, number, string]> = [
      ['success.answer', '{"model":"whisper-1"}', { 'content-type': 'application/json' }, 400, 'x5 llm service: content-type must be multipart/form-data, got "application/json"'],
      ['success.answer', '--b\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1', { 'content-type': 'multipart/form-data; boundary=b' }, 400, 'x5 llm service: part 0: no closing boundary'],
      ['success.answer', form({ model: 'whisper-1' }, null), undefined, 400, 'x5 llm service: transcription needs a file part with a filename'],
      ['success.answer', form({ model: '' }), undefined, 400, 'x5 llm service: transcription needs a model field'],
      ['success.answer', form({ model: 'whisper-1', response_format: 'srt' }), undefined, 400, 'x5 llm service: response_format "srt" is not supported (json, text, verbose_json)'],
      ['no.such.script', form({ model: 'whisper-1' }), undefined, 404, 'x5 llm service: unknown script no.such.script'],
      ['w0.directive', form({ model: 'whisper-1' }), undefined, 409, 'x5 llm service: script w0.directive does not answer audio/transcriptions'],
    ];
    for (const [id, body, headers, status, message] of cases) {
      const response = await transcribe(replay, id, body, headers);
      expect([response.status, await response.json()], message).toEqual([status, { error: { message, type: 'x5_llm_service' } }]);
    }
    const duplicate = form({ model: 'whisper-1' });
    duplicate.append('model', 'whisper-2');
    expect((await (await transcribe(replay, 'success.answer', duplicate)).json() as { error: { message: string } }).error.message)
      .toBe('x5 llm service: field model appears more than once');
    expect(replay.requests.map(r => r.outcome)).toEqual(['bad-multipart', 'bad-multipart', 'bad-transcription-request', 'bad-transcription-request',
      'unsupported-response-format', 'unknown-script', 'unscripted-route', 'bad-transcription-request']);
    // multipart 解析不了时日志保留原文；解析得了时是逐片段的投影。
    expect(replay.requests[1]!.body).toBe('--b\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1');
    expect(replay.requests[2]!.body).toEqual({ parts: [{ name: 'model', value: 'whisper-1' }] });
    const sidecar = await transcribe(replay, 'asr', form({ model: 'whisper-1' }));
    expect([sidecar.status, await sidecar.text()]).toEqual([200, '{"text":"旁车"}']);
    expect(replay.requests.at(-1)).toMatchObject({ outcome: 'served', round: 0, stream: false, end: 'eof', framesWritten: 1 });
  });

  it('llm-replay: w0.directive derives tool rounds and the final answer from the request; failures are explicit', async () => {
    const replay = replayOf({});
    const text = 'W0_DIRECTIVE {"v":1,"rounds":[[{"id":"call_a","name":"builtin-a","arguments":{"n":1.0}},{"id":"call_b","name":"builtin-b","arguments":[]}]],"final":"W0_DONE"}';
    const turn = { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'builtin-a', arguments: '{}' } }] };
    const first = await post(replay, 'w0.directive', { model: 'm', stream: true, messages: [{ role: 'user', content: [{ type: 'text', text: `<user_query>\n${text}\n</user_query>` }] }] });
    expect(await first.text()).toBe([
      `data: ${chunkJson('m', { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'builtin-a', arguments: '{"n":1.0}' } }] }, null)}\n\n`,
      `data: ${chunkJson('m', { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'builtin-b', arguments: '[]' } }] }, null)}\n\n`,
      `data: ${chunkJson('m', {}, 'tool_calls')}\n\n`,
      `data: ${JSON.stringify({ id: 'chatcmpl-x5-fixed', object: 'chat.completion.chunk', created: 1_700_000_000, model: 'm', choices: [],
        usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''));
    const final = await post(replay, 'w0.directive', { model: 'm', stream: true, messages: [{ role: 'user', content: text }, turn, { role: 'tool', content: '{}' }] });
    expect(await final.text()).toContain(chunkJson('m', { content: 'W0_DONE' }, null));
    const failures: Array<[unknown[], number, string]> = [
      [[{ role: 'user', content: 'no directive' }], 400, 'x5 llm service: w0.directive: no user message contains "W0_DIRECTIVE "'],
      [[{ role: 'user', content: `${text} ${text}` }], 400, 'x5 llm service: w0.directive: messages[0] contains "W0_DIRECTIVE " more than once'],
      [[{ role: 'user', content: 'W0_DIRECTIVE {"v":2,"rounds":[],"final":""}' }], 400, 'x5 llm service: w0.directive: messages[0]: directive v must be 1'],
      [[{ role: 'user', content: text }, turn, turn], 409, 'x5 llm service: w0.directive: 2 tool rounds answered, the directive has 1'],
    ];
    for (const [messages, status, message] of failures) {
      const response = await post(replay, 'w0.directive', { model: 'm', stream: true, messages });
      expect([response.status, await response.json()], message).toEqual([status, { error: { message, type: 'x5_llm_service' } }]);
    }
    expect(replay.requests.map(r => [r.round, r.outcome, r.status])).toEqual([
      [0, 'served', 200], [1, 'served', 200], [null, 'no-directive', 400], [null, 'ambiguous-directive', 400], [null, 'bad-directive', 400],
      [2, 'unscripted-round', 409]]);
  });

  it('llm-replay: a caller-supplied derived script is checked per request; an invalid round is a service error, never a guess', async () => {
    const replay = replayOf({ scripts: {
      echo: { description: 'answers with the model name', derive: body => ({ ok: true, index: 0,
        round: { kind: 'sse', end: 'done', frames: [{ content: String((body as { model?: unknown }).model) }, { finish: 'stop' }] } }) },
      broken: { description: 'returns a malformed round', derive: () => ({ ok: true, index: 0, round: { kind: 'sse', end: 'later', frames: [] } }) as never },
    } });
    expect(await (await post(replay, 'echo', { model: 'm-echo', stream: true, messages: [user] })).text()).toContain(chunkJson('m-echo', { content: 'm-echo' }, null));
    const error = await post(replay, 'broken', { stream: true }).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(TypeError);
    expect(((error as TypeError).cause as Error).message).toBe('llm-replay: scripts.broken derive returned an invalid round');
    expect(replay.requests.map(r => [r.scriptId, r.outcome, r.status])).toEqual([
      ['echo', 'served', 200], ['broken', 'not-found', 404], [null, 'service-error', 500]]);
  });

  it('llm-replay: a request body with a UTF-8 BOM is logged verbatim and refused as non-JSON', async () => {
    const replay = replayOf({});
    const response = await post(replay, 'success.answer', '\uFEFF{"stream":true}');
    expect(response.status).toBe(400);
    expect(replay.requests[0]).toMatchObject({ outcome: 'bad-json', body: '\uFEFF{"stream":true}' });
  });
});

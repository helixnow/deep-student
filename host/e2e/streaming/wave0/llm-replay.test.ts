/**
 * D4 llm-replay 对 G3 模拟 LLM 服务（llm-service.ts）的替换性：
 * 1. 同一脚本、同一请求：状态、内容类型、响应字节与请求日志逐项相同——内置轮次脚本、推导脚本
 *    `w0.directive`、`/embeddings`、`/audio/transcriptions`、旁车脚本，以及各自的失败路径。
 * 2. 经真实聊天管线（wave0 runner + 真实 llm / llm-providers）录制：回放与 HTTP 录制之间的差异，
 *    不超过两次 HTTP 录制之间本来就有的差异；LLM 请求日志完全相同。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { streamingHost, withoutToolExecutors } from '../__fixtures__/host.ts';
import {
  LLM_REPLAY_ORIGIN, LLM_REPLAY_SCRIPTS, createLlmReplay, providerSidecarScripts, type LlmReplayService,
} from '../../../plugins/llm-providers/api.ts';
import { providerScripts, scripts as serviceScripts, startLlmService, type LlmService } from './llm-service.ts';
import { hostDriver, runScenario, type ScenarioFile } from './runner.ts';
import { candidateRules, type CandidateReport } from './normalize-candidates.ts';
import type { StreamRecord } from './recorder.ts';

const roundScripts = Object.entries(serviceScripts).flatMap(([id, script]) => 'rounds' in script ? [[id, script] as const] : []);

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });

/** 同一份脚本的 HTTP 服务与回放；回放用缺省的内置脚本表。 */
async function pair(extra: Parameters<typeof startLlmService>[0] = {}) {
  const http = await startLlmService(extra);
  const replay = createLlmReplay(extra.extraScripts ? { extraScripts: extra.extraScripts } : {});
  cleanup.push(() => http.stop(), () => replay.stop());
  return { http, replay };
}
type Send = (url: string, init: RequestInit) => Promise<Response>;
const viaHttp: Send = (url, init) => fetch(url, init);
const viaReplay = (replay: LlmReplayService): Send => (url, init) => replay.fetch(url, init);

interface Exchange { status: number; contentType: string | null; cacheControl: string | null; bodyBase64: string }
async function exchange(send: Send, url: string, body: BodyInit, contentType: string | null = 'application/json',
  held?: { chunks?: number; length?: number }): Promise<Exchange> {
  const controller = new AbortController();
  const response = await send(url, { method: 'POST', ...(contentType === null ? {} : { headers: { 'content-type': contentType } }), body, signal: controller.signal });
  const head = { status: response.status, contentType: response.headers.get('content-type'), cacheControl: response.headers.get('cache-control') };
  if (!held) return { ...head, bodyBase64: Buffer.from(await response.arrayBuffer()).toString('base64') };
  // A held stream never ends: read what was written, then close it like a cancelling client.
  const reader = response.body!.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  while ((held.chunks !== undefined && parts.length < held.chunks) || (held.length !== undefined && length < held.length)) {
    const next = await reader.read();
    if (next.done) break;
    parts.push(next.value);
    length += next.value.byteLength;
  }
  controller.abort();
  return { ...head, bodyBase64: Buffer.concat(parts).toString('base64') };
}

/** 两边各发一次同样的字节（同一 content-type），返回两边的应答。 */
async function both(http: LlmService, replay: LlmReplayService, scriptId: string, route: string, body: BodyInit, contentType: string | null) {
  const fromReplay = await exchange(viaReplay(replay), `${replay.baseUrl(scriptId)}/${route}`, body, contentType);
  const fromHttp = await exchange(viaHttp, `${http.baseUrl(scriptId)}/${route}`, body, contentType);
  return { fromReplay, fromHttp };
}

/** 只有传输不同：undici 自动补的连接类请求头（host、accept、user-agent …）回放看不到，应用给的请求头两边都在。 */
function expectSameLogsButTransportHeaders(replay: LlmReplayService, http: LlmService) {
  const withoutHeaders = (log: LlmService['requests']) => log.map(({ raw, ...entry }) => raw ? { ...entry, raw: { ...raw, requestHeaders: [] } } : entry);
  expect(withoutHeaders(replay.requests)).toEqual(withoutHeaders(http.requests));
  const pairs = (flat: string[]) => flat.flatMap((value, i) => i % 2 === 0 ? [`${value.toLowerCase()}: ${flat[i + 1]}`] : []);
  replay.requests.forEach((entry, i) => {
    if (!entry.raw) return;
    const sent = new Set(pairs(http.requests[i]!.raw!.requestHeaders));
    for (const header of pairs(entry.raw.requestHeaders)) expect(sent.has(header), header).toBe(true);
  });
}

const tools = [{ type: 'function', function: { name: 'lookup_fixture', parameters: { type: 'object' } } }];
const toolTurn = (n: number) => ({ role: 'assistant', content: '', tool_calls: [{ id: `call_${n}`, type: 'function', function: { name: 'lookup_fixture', arguments: '{}' } }] });
function roundBody(round: number, stream: boolean): string {
  const messages: unknown[] = [{ role: 'system', content: 's' }, { role: 'user', content: '问题' }];
  for (let n = 0; n < round; n++) messages.push(toolTurn(n), { role: 'tool', tool_call_id: `call_${n}`, content: 'r' });
  return JSON.stringify({ model: 'parity-model', stream, tools, messages });
}

const bytes = (...parts: Array<string | Uint8Array>) => new Uint8Array(Buffer.concat(parts.map(part => typeof part === 'string' ? Buffer.from(part) : part)));
/** 16 kHz 单声道 16 位 PCM，6400 字节数据 = 200 ms。 */
const WAV = bytes('RIFF$\u0019\u0000\u0000WAVEfmt ', new Uint8Array([16, 0, 0, 0, 1, 0, 1, 0, 0x80, 0x3e, 0, 0, 0, 0x7d, 0, 0, 2, 0, 16, 0]),
  'data', new Uint8Array([0, 0x19, 0, 0]), new Uint8Array(6400));
const MP3 = bytes('ID3\u0004\u0000', new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x00, 0xfe, 0x80]));
const FORM = 'multipart/form-data; boundary=w0b';
const file = (data: Uint8Array, filename: string | null = 'a.wav', type = 'audio/wav') =>
  [`--w0b\r\nContent-Disposition: form-data; name="file"${filename === null ? '' : `; filename="${filename}"`}\r\nContent-Type: ${type}\r\n\r\n`, data, '\r\n'];
const field = (name: string, value: string | Uint8Array) => [`--w0b\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`, value, '\r\n'];
const form = (...parts: Array<Array<string | Uint8Array>>) => bytes(...parts.flat(), '--w0b--\r\n');

const user = (content: unknown) => ({ role: 'user', content });
const DIRECTIVE = 'W0_DIRECTIVE {"v":1,"rounds":[[{"id":"call_w0","name":"builtin-template_get","arguments":{"templateId":"61b3c4e1","version":1.0,"big":12345678901234567890}}],'
  + '[{"id":"call_a","name":"a","arguments":"s"},{"id":"call_b","name":"b","arguments":null}]],"final":"W0_DONE 完成"}';
const directiveTurn = { role: 'assistant', content: null, tool_calls: [{ id: 'call_w0', type: 'function', function: { name: 'builtin-template_get', arguments: '{}' } }] };
const toolResult = { role: 'tool', tool_call_id: 'call_w0', content: '{}' };

describe('llm-replay ↔ G3 llm-service parity', () => {
  it('llm-replay: the built-in script table is the service table (fixed rounds verbatim, w0.directive derived)', () => {
    expect(Object.keys(LLM_REPLAY_SCRIPTS)).toEqual(Object.keys(serviceScripts));
    for (const [id, script] of Object.entries(serviceScripts)) {
      const builtin = LLM_REPLAY_SCRIPTS[id as keyof typeof LLM_REPLAY_SCRIPTS];
      if ('rounds' in script) expect(builtin, id).toEqual(script);
      else expect([builtin.description, 'derive' in builtin], id).toEqual([script.description, true]);
    }
  });

  it('llm-replay: every built-in round script answers byte-for-byte like the HTTP service, with identical request logs', async () => {
    const { http, replay } = await pair();
    for (const [id, script] of roundScripts) {
      for (const stream of [true, false]) {
        // One request past the last round exercises the 409 path.
        for (let round = 0; round <= script.rounds.length; round++) {
          const body = roundBody(round, stream);
          const url = (base: string) => `${base}/chat/completions`;
          const scripted = script.rounds[round];
          const heldFrames = stream && scripted?.kind === 'sse' && scripted.end === 'hold' ? scripted.frames.length : null;
          const fromReplay = await exchange(viaReplay(replay), url(replay.baseUrl(id)), body, 'application/json', heldFrames === null ? undefined : { chunks: heldFrames });
          const fromHttp = await exchange(viaHttp, url(http.baseUrl(id)), body, 'application/json',
            heldFrames === null ? undefined : { length: Buffer.from(fromReplay.bodyBase64, 'base64').byteLength });
          expect(fromReplay, `${id} round ${round} stream ${stream}`).toEqual(fromHttp);
        }
      }
    }
    expect(await http.whenIdle(5_000)).toBe(true);
    expect(await replay.whenIdle(5_000)).toBe(true);
    expect(replay.requests.length).toBe(2 * roundScripts.reduce((n, [, s]) => n + s.rounds.length + 1, 0));
    expect(replay.requests).toEqual(http.requests);
    expect(new Set(replay.requests.map(r => r.end))).toEqual(new Set(['done', 'eof', 'http-error', 'client-closed']));
  });

  it('llm-replay: w0.directive derives the same rounds, final answer and failures as the HTTP service', async () => {
    const { http, replay } = await pair();
    const conversations: unknown[][] = [
      [user(`<user_query>\n${DIRECTIVE}\n</user_query>\n<injected_context>{"note":"W0"}</injected_context>`)],
      [user([{ type: 'text', text: '前言 ' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'text', text: DIRECTIVE }])],
      [user(DIRECTIVE), directiveTurn, toolResult],
      [user(DIRECTIVE), directiveTurn, toolResult, directiveTurn, toolResult],
      [user(DIRECTIVE), directiveTurn, toolResult, user('追问'), directiveTurn, toolResult],
      [user(DIRECTIVE), directiveTurn, toolResult, directiveTurn, toolResult, directiveTurn],
      [user('W0_DIRECTIVE {"v":1,"rounds":[],"final":"直接回答"}')],
      [user('no directive')],
      [],
      [user(`${DIRECTIVE}\n${DIRECTIVE}`)],
      [user('W0_DIRECTIVE not json')],
      [user('W0_DIRECTIVE {"v":1,"rounds":[],"final":"x"')],
      [user('W0_DIRECTIVE {"v":1,"rounds":[],"final":"x",}')],
      [user('W0_DIRECTIVE {"v":2,"rounds":[],"final":"x"}')],
      [user('W0_DIRECTIVE {"v":1,"rounds":[],"final":"x","extra":1}')],
      [user('W0_DIRECTIVE {"v":1,"rounds":[[]],"final":"x"}')],
      [user('W0_DIRECTIVE {"v":1,"rounds":[],"final":1}')],
      [user('W0_DIRECTIVE {"v":1,"rounds":[[{"id":"","name":"a","arguments":{}}]],"final":""}')],
      [user('W0_DIRECTIVE {"v":1,"rounds":[[{"id":"c","name":"a"}]],"final":""}')],
    ];
    for (const messages of conversations) {
      for (const stream of [true, false]) {
        const body = JSON.stringify({ model: 'parity-model', stream, messages });
        const { fromReplay, fromHttp } = await both(http, replay, 'w0.directive', 'chat/completions', body, 'application/json');
        expect(fromReplay, `${body.slice(0, 160)}`).toEqual(fromHttp);
      }
    }
    expect(replay.requests).toEqual(http.requests);
    expect(new Set(replay.requests.map(r => r.outcome))).toEqual(new Set(['served', 'unscripted-round', 'no-directive', 'ambiguous-directive', 'bad-directive']));
    expect(new Set(replay.requests.map(r => r.round))).toEqual(new Set([0, 1, 2, 3, null]));
  });

  it('llm-replay: /embeddings answers and refuses byte-for-byte like the HTTP service', async () => {
    const { http, replay } = await pair();
    const cases: Array<[string, string]> = [
      ['vfs.x', JSON.stringify({ model: 'w0-text-embedding', input: ['导数描述函数的变化率', '光合作用'], encoding_format: 'float' })],
      ['vfs.x', JSON.stringify({ model: 'w0-vl-embedding', input: [{ text: '细胞' }, { image: 'data:image/png;base64,AAAA' }, { text: '图', instruction: '检索', image: null }] })],
      ['success.answer', JSON.stringify({ model: 'w0-text-embedding', input: 'a', dimensions: 16 })],
      ['w0.directive', '{"model":"w0-text-embedding","input":"\\ud800 孤立代理 😀"}'],
      ['error.http-500', JSON.stringify({ model: 'w0-text-embedding', input: 'a' })],
      ['error.http-500', '{not json'],
      ['vfs.x', ''],
      ['vfs.x', '[]'],
      ['vfs.x', '{"input":"a"}'],
      ['vfs.x', '{"model":"text-embedding-3-small","input":"a"}'],
      ['vfs.x', '{"model":"w0-text-embedding","input":"a","encoding_format":"base64"}'],
      ['vfs.x', '{"model":"w0-text-embedding","input":"a","dimensions":0}'],
      ['vfs.x', '{"model":"w0-text-embedding","input":"a","dimensions":1.5}'],
      ['vfs.x', '{"model":"w0-text-embedding","input":[]}'],
      ['vfs.x', '{"model":"w0-text-embedding","input":[1]}'],
      ['vfs.x', '{"model":"w0-vl-embedding","input":[{"text":1}]}'],
      ['vfs.x', '{"model":"w0-vl-embedding","input":[{"audio":"x"}]}'],
    ];
    for (const [id, body] of cases) {
      const { fromReplay, fromHttp } = await both(http, replay, id, 'embeddings', body, 'application/json');
      expect(fromReplay, `${id} ${body.slice(0, 120)}`).toEqual(fromHttp);
    }
    expect(replay.requests).toEqual(http.requests);
    expect(new Set(replay.requests.map(r => r.outcome))).toEqual(new Set(['served', 'bad-json', 'bad-embedding-request', 'unknown-embedding-model']));
  });

  it('llm-replay: /audio/transcriptions decodes, answers and refuses byte-for-byte like the HTTP service', async () => {
    const { http, replay } = await pair();
    const cases: Array<[string, string | null, ReturnType<typeof bytes>]> = [
      ['success.answer', FORM, form(file(WAV), field('model', 'whisper-1'), field('language', 'zh'))],
      ['success.answer', FORM, form(field('model', 'whisper-1'), field('response_format', 'text'), file(WAV))],
      ['success.thinking', FORM, form(file(WAV), field('model', 'whisper-1'), field('response_format', 'verbose_json'), field('language', 'zh'))],
      ['success.answer', FORM, form(file(MP3, 'a.mp3', 'audio/mpeg'), field('model', 'whisper-1'), field('response_format', 'verbose_json'))],
      ['success.empty', FORM, form(file(WAV), field('model', 'whisper-1'), field('response_format', 'verbose_json'))],
      ['success.answer', FORM, form(file(WAV), field('model', 'whisper-1'), field('prompt', '术语'), field('temperature', '0'), field('timestamp_granularities[]', 'segment'))],
      ['success.answer', 'multipart/form-data; charset=utf-8; boundary="w0b"', form(file(WAV), field('model', 'whisper-1'))],
      ['success.answer', FORM, form(file(WAV), field('model', 'whisper-1'), field('language', '\uFEFFzh'), field('prompt', new Uint8Array([0xff, 0xfe, 0x41, 0xe4, 0xb8])))],
      ['tool.second-round', FORM, form(file(WAV), field('model', 'whisper-1'))],
      ['interrupt.hold-after-partial', FORM, form(file(WAV), field('model', 'whisper-1'))],
      ['error.eof-after-partial', FORM, form(file(WAV), field('model', 'whisper-1'), field('response_format', 'text'))],
      ['error.http-500', FORM, form(file(WAV), field('model', 'whisper-1'))],
      ['no.such.script', FORM, form(file(WAV), field('model', 'whisper-1'))],
      ['w0.directive', FORM, form(file(WAV), field('model', 'whisper-1'))],
      ['success.answer', 'application/json', bytes('{"model":"whisper-1"}')],
      ['success.answer', null, form(file(WAV), field('model', 'whisper-1'))],
      ['success.answer', 'multipart/form-data', form(file(WAV), field('model', 'whisper-1'))],
      ['success.answer', FORM, bytes('no boundary here')],
      ['success.answer', FORM, bytes('--w0bX\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--w0b--\r\n')],
      ['success.answer', FORM, bytes('--w0b\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1')],
      ['success.answer', FORM, bytes('--w0b\r\nContent-Disposition: form-data; name="model"\r\n--w0b--\r\n')],
      ['success.answer', FORM, bytes('--w0b\r\nNoColonHere\r\n\r\nx\r\n--w0b--\r\n')],
      ['success.answer', FORM, bytes('--w0b\r\nContent-Disposition: attachment; name="model"\r\n\r\nx\r\n--w0b--\r\n')],
      ['success.answer', FORM, bytes('--w0b\r\nContent-Disposition: form-data; filename="a.wav"\r\n\r\nx\r\n--w0b--\r\n')],
      ['success.answer', FORM, bytes('--w0b\r\n\r\nheaderless\r\n--w0b--\r\n')],
      ['success.answer', FORM, form(file(WAV), field('model', 'whisper-1'), field('model', 'whisper-2'))],
      ['success.answer', FORM, form(field('model', 'whisper-1'))],
      ['success.answer', FORM, form(file(WAV, null), field('model', 'whisper-1'))],
      ['success.answer', FORM, form(file(WAV))],
      ['success.answer', FORM, form(file(WAV), field('model', ''))],
      ['success.answer', FORM, form(file(WAV), field('model', 'whisper-1'), field('response_format', 'srt'))],
    ];
    for (const [id, contentType, body] of cases) {
      const { fromReplay, fromHttp } = await both(http, replay, id, 'audio/transcriptions', body, contentType);
      expect(fromReplay, `${id} ${contentType} ${Buffer.from(body).toString('latin1').slice(0, 120)}`).toEqual(fromHttp);
    }
    // A real client: FormData picks its own random boundary on each side; the answer and the decoded log do not depend on it.
    for (const responseFormat of ['json', 'verbose_json']) {
      const data = () => {
        const value = new FormData();
        value.append('file', new Blob([WAV], { type: 'audio/wav' }), 'a.wav');
        value.append('model', 'whisper-1');
        value.append('response_format', responseFormat);
        return value;
      };
      const fromReplay = await exchange(viaReplay(replay), `${replay.baseUrl('success.answer')}/audio/transcriptions`, data(), null);
      const fromHttp = await exchange(viaHttp, `${http.baseUrl('success.answer')}/audio/transcriptions`, data(), null);
      expect(fromReplay, `FormData ${responseFormat}`).toEqual(fromHttp);
    }
    expect(replay.requests).toEqual(http.requests);
    expect(new Set(replay.requests.map(r => r.outcome))).toEqual(new Set(['served', 'unknown-script', 'unscripted-route', 'bad-multipart',
      'bad-transcription-request', 'unsupported-response-format']));
  });

  it('llm-replay: the shared failure paths answer and log like the HTTP service', async () => {
    const { http, replay } = await pair();
    const cases: Array<[string, RequestInit]> = [
      ['/s/success.answer/v1/chat/completions', { method: 'GET' }],
      ['/s/success.answer/v1/completions', { method: 'POST', body: '{}' }],
      ['/s/no.such.script/v1/chat/completions', { method: 'POST', body: '{"stream":true}' }],
      ['/s/success.answer/v1/chat/completions', { method: 'POST', body: '{not json' }],
      ['/s/w0.directive/v1/chat/completions', { method: 'POST', body: '{not json' }],
      ['/s/success.answer/v1/chat/completions', { method: 'POST', body: '\uFEFF{"stream":true}' }],
      ['/s/tool.second-round/v1/chat/completions', { method: 'POST', body: '{"stream":true,"messages":[{"role":"user","content":"q"}]}' }],
      ['/s/success.answer/v1/embeddings', { method: 'GET' }],
      ['/s/success.answer/v1/audio/transcriptions?x=1', { method: 'POST', body: '' }],
    ];
    for (const [path, init] of cases) {
      const [a, b] = [await fetch(`${http.url}${path}`, init), await replay.fetch(`${replay.url}${path}`, init)];
      expect([b.status, b.headers.get('content-type'), await b.text()], path).toEqual([a.status, a.headers.get('content-type'), await a.text()]);
    }
    expect(replay.requests).toEqual(http.requests);
  });

  it('llm-replay: the owner provider sidecar fixture replays byte-for-byte, with the same cursors and logs', async () => {
    const source: unknown = JSON.parse(readFileSync(new URL('./__fixtures__/ai-grading-scripted.provider.json', import.meta.url), 'utf8'));
    const http = await startLlmService({ extraScripts: providerScripts(source) });
    const replay = createLlmReplay({ extraScripts: providerSidecarScripts(source) });
    cleanup.push(() => http.stop(), () => replay.stop());
    const sidecar = providerSidecarScripts(source);
    expect(Object.keys(sidecar)).toEqual(Object.keys(providerScripts(source)));
    const body = '{ "model":"wp052-model", "stream":true, "messages":[] }';
    for (const [id, script] of Object.entries(sidecar)) {
      for (let n = 0; n <= script.responses.length; n++) {
        const [a, b] = [await fetch(`${http.baseUrl(id)}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }),
          await replay.fetch(`${replay.baseUrl(id)}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })];
        const scripted = script.responses[n];
        for (const key of Object.keys(scripted?.headers ?? { 'content-type': '' })) expect(b.headers.get(key), `${id}#${n} ${key}`).toBe(a.headers.get(key));
        expect([b.status, Buffer.from(await b.arrayBuffer()).toString('base64')], `${id}#${n}`)
          .toEqual([a.status, Buffer.from(await a.arrayBuffer()).toString('base64')]);
      }
    }
    expect(await http.whenIdle(5_000)).toBe(true);
    expectSameLogsButTransportHeaders(replay, http);
  });

  it('llm-replay: a sidecar script answers transcriptions and embeddings like the HTTP service (binary request text included)', async () => {
    const source = { note: 'asr', 'asr.scripted': [
      { status: 200, headers: { 'content-type': 'application/json' }, chunks: ['{"text":', '"旁车转写"}'] },
      { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '1' }, chunks: ['{"error":"busy"}'] },
    ] };
    const { http, replay } = await pair({ extraScripts: providerScripts(source) });
    const body = form(file(new Uint8Array([0x00, 0xff, 0xc3, 0x28, 0xe2, 0x82, 0xef, 0xbb, 0xbf, 0x80])), field('model', 'whisper-1'));
    for (let n = 0; n <= 2; n++) {
      const { fromReplay, fromHttp } = await both(http, replay, 'asr.scripted', 'audio/transcriptions', body, FORM);
      expect(fromReplay, `transcription #${n}`).toEqual(fromHttp);
    }
    const { fromReplay, fromHttp } = await both(http, replay, 'asr.scripted', 'embeddings', '{"model":"w0-text-embedding","input":"a"}', 'application/json');
    expect(fromReplay).toEqual(fromHttp);
    expectSameLogsButTransportHeaders(replay, http);
    expect(replay.requests.map(r => [r.round, r.outcome, r.status, r.end])).toEqual([
      [0, 'served', 200, 'eof'], [1, 'served', 503, 'http-error'], [2, 'unscripted-round', 409, 'http-error'], [null, 'served', 200, 'done']]);
  });
});

const scenarioFile = JSON.parse(readFileSync(new URL('./streaming.scenarios.json', import.meta.url), 'utf8')) as ScenarioFile;
const scenario = (id: string) => {
  const found = scenarioFile.scenarios.find(item => item.id === id);
  if (!found) throw new Error(`no scenario ${id}`);
  return id === 'chat.stream.tool.second-round' ? withoutToolExecutors(found) : found;
};

async function recordHttp(id: string, take: string): Promise<StreamRecord> {
  const llm = await startLlmService();
  const fixture = await streamingHost('answer', { diagnostics: true, realProviders: true });
  try {
    return await runScenario(scenario(id), hostDriver(fixture.host), { side: 'B', take, llm });
  } finally {
    await fixture.dispose();
    await llm.stop();
  }
}
async function recordReplay(id: string, take: string): Promise<StreamRecord> {
  const fixture = await streamingHost('answer', { diagnostics: true, realProviders: true, llmReplay: {} });
  try {
    return await runScenario(scenario(id), hostDriver(fixture.host), { side: 'B', take, llm: fixture.host.ctx.llmReplay });
  } finally {
    await fixture.dispose();
  }
}
const differenceKinds = (report: CandidateReport) => new Set(report.candidates.map(rule => `${rule.kind} ${rule.pattern}`));

describe('llm-replay through the real chat pipeline', () => {
  for (const id of ['chat.stream.success.answer', 'chat.stream.error.eof-after-partial',
    'chat.stream.interrupt.cancel-after-partial', 'chat.stream.tool.second-round']) {
    it(`llm-replay: ${id} recorded over the replay is indistinguishable from another HTTP take`, async () => {
      const first = await recordHttp(id, 'B1');
      const second = await recordHttp(id, 'B2');
      const replayed = await recordReplay(id, 'B3');
      expect(replayed.llmOrigin).toBe(LLM_REPLAY_ORIGIN);
      expect(replayed.llmRequests.length).toBeGreaterThan(0);
      expect(replayed.llmRequests).toEqual(first.llmRequests);
      const selfRepeat = candidateRules(first, second);
      const cross = candidateRules(first, replayed);
      // Every difference from the HTTP take is one a second HTTP take also shows (ids, timestamps, the LLM origin) …
      expect([...differenceKinds(cross)].filter(kind => !differenceKinds(selfRepeat).has(kind))).toEqual([]);
      // … and nothing else differs except measured wall-clock durations.
      expect(cross.unrepeatable.filter(item => !/\.durationMs$/.test(item.jsonPath))).toEqual([]);
    }, 120_000);
  }
});

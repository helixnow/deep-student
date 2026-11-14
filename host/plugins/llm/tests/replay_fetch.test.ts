/**
 * llm-replay 接入 llm 插件：只有发往回放源的请求、且挂载了 `dstu.llm-replay` 时才交给回放；其余请求与未挂载时
 * 行为不变。集成用例挂真实的 llm-providers / llm / translation，经真实命令与服务跑到回放。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import providers from '../../llm-providers/index.ts';
import { LLM_REPLAY_ORIGIN, createLlmReplay, llmReplayPlugin, type ReplayScript } from '../../llm-providers/api.ts';
import llm from '../index.ts';
import translation from '../../translation/index.ts';
import { tokenizer } from '../../../platform/native/tokenizer/index.ts';
import { image } from '../../../platform/native/image/index.ts';
import { realInjectionBudget } from './host.ts';
import { makeConfig } from './support.ts';
import { defaultSingleShotOptions } from '../api.ts';
import { withLlmReplay } from '../src/replay_fetch.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';

const SCRIPTS = {
  answer: { description: 'fixed answer', rounds: [{ kind: 'sse', end: 'done', frames: [{ content: '回放' }, { content: '回答' }, { finish: 'stop' }] }] },
  overloaded: { description: 'provider 503', rounds: [{ kind: 'http-error', status: 503, body: '{"error":{"message":"overloaded"}}' }] },
} satisfies Record<string, ReplayScript>;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('withLlmReplay', () => {
  it('llm-replay: only replay-origin requests reach the mounted replay; everything else keeps the original fetcher', async () => {
    const replay = createLlmReplay({ scripts: SCRIPTS });
    const original = vi.fn(async (input: Parameters<typeof fetch>[0]) => new Response(`original ${String(input)}`));
    const fetcher = withLlmReplay(original, () => replay);
    const replayed = await fetcher(`${replay.baseUrl('answer')}/chat/completions`, { method: 'POST', body: '{"stream":false}' });
    expect(await replayed.json()).toMatchObject({ choices: [{ message: { content: '回放回答' } }] });
    expect(await (await fetcher('http://127.0.0.1:9/v1/chat/completions')).text()).toBe('original http://127.0.0.1:9/v1/chat/completions');
    expect(await (await fetcher('https://llm-replay.invalid/s/answer/v1')).text()).toBe('original https://llm-replay.invalid/s/answer/v1');
    expect(original).toHaveBeenCalledTimes(2);
    expect(replay.requests.map(r => r.path)).toEqual(['/s/answer/v1/chat/completions']);
  });

  it('llm-replay: without a mounted replay, replay-origin requests go to the original fetcher unchanged', async () => {
    const original = vi.fn(async () => new Response('original'));
    const init = { method: 'POST', body: '{}' };
    const url = `${LLM_REPLAY_ORIGIN}/s/answer/v1/chat/completions`;
    expect(await (await withLlmReplay(original, () => undefined)(url, init)).text()).toBe('original');
    expect(original).toHaveBeenCalledWith(url, init);
  });

  it('llm-replay: replay failures surface as the replay failure, never as a fallback to the network', async () => {
    const replay = createLlmReplay({ scripts: SCRIPTS });
    await replay.stop();
    const original = vi.fn(async () => new Response('original'));
    await expect(withLlmReplay(original, () => replay)(`${replay.baseUrl('answer')}/chat/completions`, { method: 'POST' }))
      .rejects.toThrow('fetch failed');
    expect(original).not.toHaveBeenCalled();
  });
});

function memorySettings(): SettingsStore {
  const values = new Map<string, string>();
  return { get: key => values.get(key) ?? null, save: (key, value) => { values.set(key, value); },
    delete: key => values.delete(key), listByPrefix: () => [], deleteByPrefix: () => 0,
    getSecret: async key => values.get(key) ?? null, saveSecret: async (key, value) => { values.set(key, value); }, deleteSecret: async key => values.delete(key) };
}
const provide = () => ({ settings: memorySettings(), secrets: { isEncryptedFormat: () => false }, nativeTokenizer: tokenizer, nativeImage: image,
  injectionBudget: realInjectionBudget, vfsDatabase: {}, vfsRepo: { essays: {} } });

describe('llm-replay through the real llm plugin', () => {
  it('llm-replay: commands, streaming services and translation (llmHttp) are served by the mounted replay', async () => {
    // Mounted after llm: the lookup happens per request, so order does not matter.
    const host = await createTestHost({ plugins: [providers, llm, translation, [llmReplayPlugin, { scripts: SCRIPTS }]], provide: provide() });
    try {
      const replay = host.ctx.llmReplay;
      const config = makeConfig({ id: 'replay', enabled: true, model: 'replay-model', baseUrl: replay.baseUrl('answer'), apiKey: 'sk-replay' });
      const messages = [{ role: 'user', content: 'hello' }];

      expect(await host.invoke('test_api_connection', { apiKey: 'sk-replay', apiBase: config.baseUrl, model: 'replay-model' }))
        .toMatchObject({ ok: true });

      const deltas: string[] = [];
      const single = await host.ctx.llmStreaming.singleShotCompletion(config, { model: 'replay-model', messages }, null, 'session', 'build',
        defaultSingleShotOptions('Replay'), delta => { deltas.push(delta); return true; });
      expect([single.content, deltas]).toEqual(['回放回答', ['回放', '回答']]);

      const unified = await host.ctx.llmModel2Streaming.callUnifiedModel2StreamWithConfig(config, 0, {
        context: {}, chatHistory: [{ role: 'user', content: 'unified chat' }], subject: '', enableChainOfThought: false, enableThinking: false,
        taskContext: 'chat_v2', sink: { emit() {} }, streamEvent: 'chat_v2_event_replay', disableTools: true,
      });
      expect(unified).toMatchObject({ assistant_message: '回放回答', cancelled: false });

      vi.spyOn(host.ctx.llm, 'getModel2Config').mockResolvedValue(config);
      expect(await host.invoke('call_llm_for_boundary', { prompt: 'find boundary' })).toMatchObject({ assistant_message: '回放回答' });

      vi.spyOn(host.ctx.llm, 'getTranslationModelConfig').mockResolvedValue(config);
      expect(await host.invoke('translate_text_stream', { request: { session_id: 'replay-translation', text: 'hello', src_lang: 'en', tgt_lang: 'zh' } }))
        .toMatchObject({ translated_text: '回放回答' });

      expect(replay.requests.length).toBeGreaterThanOrEqual(5);
      for (const entry of replay.requests) {
        expect(entry).toMatchObject({ method: 'POST', path: '/s/answer/v1/chat/completions', scriptId: 'answer', outcome: 'served', status: 200 });
        expect(entry.body).toMatchObject({ model: 'replay-model' });
      }
      expect(await replay.whenIdle(1_000)).toBe(true);
    } finally {
      await host.dispose();
    }
  });

  it('llm-replay: a scripted provider error goes through the real error handling unchanged', async () => {
    const host = await createTestHost({ plugins: [[llmReplayPlugin, { scripts: SCRIPTS }], providers, llm, translation], provide: provide() });
    try {
      const replay = host.ctx.llmReplay;
      const outcome = await host.invoke('test_api_connection', { apiKey: 'sk-replay', apiBase: replay.baseUrl('overloaded'), model: 'replay-model' });
      expect(outcome).toMatchObject({ ok: false });
      expect(replay.requests.map(r => [r.scriptId, r.outcome, r.status])).toEqual([['overloaded', 'served', 503]]);
    } finally {
      await host.dispose();
    }
  });

  it('llm-replay: default off — without the plugin a replay-origin request takes the normal fetch path untouched', async () => {
    const original = vi.fn<typeof fetch>(async () => new Response('{"error":{"message":"not replayed"}}', { status: 401, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', original);
    const host = await createTestHost({ plugins: [providers, llm, translation], provide: provide() });
    try {
      expect(host.ctx.reflect.get('llmReplay', false)).toBeUndefined();
      const apiBase = `${LLM_REPLAY_ORIGIN}/s/answer/v1`;
      expect(await host.invoke('test_api_connection', { apiKey: 'sk-replay', apiBase, model: 'replay-model' })).toMatchObject({ ok: false });
      expect(original).toHaveBeenCalledTimes(1);
      expect(original.mock.calls[0]![0]).toBe(`${apiBase}/chat/completions`);
    } finally {
      await host.dispose();
    }
  });
});

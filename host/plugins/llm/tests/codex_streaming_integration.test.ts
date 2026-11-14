import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestHost } from '../../../kernel/testing.ts';
import providers from '../../llm-providers/index.ts';
import llm from '../index.ts';
import translation from '../../translation/index.ts';
import { tokenizer } from '../../../platform/native/tokenizer/index.ts';
import { image } from '../../../platform/native/image/index.ts';
import { realInjectionBudget } from './host.ts';
import { makeConfig } from './support.ts';
import { defaultSingleShotOptions } from '../api.ts';
import { LlmConfigStore } from '../src/config_store.ts';
import { createEssayTransport } from '../src/essay_grading/transport.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';

describe('L02 → live L01 Codex auth integration', () => {
  it('uses the active camelCase session, refreshes once and streams from the authenticated transport', async () => {
    let refreshed = 0;
    const authHeaders: string[] = [];
    const server = createServer((request, response) => {
      if (request.url === '/oauth/token') {
        refreshed++;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ access_token: 'fresh', refresh_token: 'refresh', expires_in: 3600 }));
      } else {
        authHeaders.push(request.headers.authorization ?? '');
        if (request.headers.authorization !== 'Bearer fresh') { response.writeHead(401); response.end('{"error":{"code":"unauthorized"}}'); return; }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: {"type":"response.output_text.delta","delta":"authenticated"}\n\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}\n\n');
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const endpoints = { clientId: 'test', authorizeUrl: `${base}/oauth/authorize`, tokenUrl: `${base}/oauth/token`,
      revokeUrl: `${base}/oauth/revoke`, deviceUserCodeUrl: `${base}/device/usercode`, deviceTokenUrl: `${base}/device/token`,
      deviceVerificationUrl: `${base}/device`, deviceRedirectUrl: `${base}/device/callback`, responsesUrl: `${base}/codex/responses`, usageUrl: `${base}/wham/usage` };
    const values = new Map([['internal.oauth.openai_codex.session', JSON.stringify({ schemaVersion: 1, accessToken: 'old',
      refreshToken: 'refresh', idToken: null, expiresAtUnixMs: Date.now() + 3600000, accountId: 'account', email: null,
      planType: null, isFedramp: false, lastRefreshAt: null })]]);
    const settings: SettingsStore = { get: key => values.get(key) ?? null, save: (key, value) => { values.set(key, value); },
      delete: key => values.delete(key), listByPrefix: () => [], deleteByPrefix: () => 0,
      getSecret: async key => values.get(key) ?? null, saveSecret: async (key, value) => { values.set(key, value); }, deleteSecret: async key => values.delete(key) };
    const host = await createTestHost({ plugins: [[providers, { codexEndpoints: endpoints }], llm, translation], provide: {
      settings, secrets: { isEncryptedFormat: () => false }, nativeTokenizer: tokenizer, nativeImage: image,
      injectionBudget: realInjectionBudget, vfsDatabase: {}, vfsRepo: { essays: {} },
    } });
    try {
      const store = new LlmConfigStore({ settings, isEncryptedFormat: () => false, openCrypto: async () => { throw new Error('unused'); },
        hasUsableCodexSession: async () => (await host.ctx.llmCodexAuth.status()).hasUsableSession });
      expect(await store.hasUsableCodexSession()).toBe(true);
      const config = makeConfig({ id: 'codex', enabled: true, model: 'gpt-5', authMode: 'openai_codex_oauth', providerType: 'openai_codex',
        baseUrl: 'https://api.openai.com/v1', apiProtocol: 'openai_responses', supportsOpenaiResponses: true });
      const deltas: string[] = [];
      const prepared = await host.ctx.llmProviderRequests.prepareModel2Async(config,
        { model: 'gpt-5', messages: [{ role: 'user', content: 'hello' }], stream: true },
        'chat_v2_event_session_var_main_run_first', null, false);
      expect(prepared.request.url).toBe(`${base}/codex/responses`);
      expect(prepared.request.body).toMatchObject({ stream: true, prompt_cache_key: 'session' });
      expect(prepared.codexRequest?.codex?.sessionId).toBe('session');
      expect(prepared.requiresExplicitStreamCompletion).toBe(true);
      const result = await host.ctx.llmStreaming.singleShotCompletion(config, { model: 'gpt-5', messages: [{ role: 'user', content: 'hello' }] },
        null, 'session', 'build', defaultSingleShotOptions('Codex'), delta => { deltas.push(delta); return true; });
      expect(result.content).toBe('authenticated'); expect(deltas).toEqual(['authenticated']);
      expect(authHeaders).toEqual(['Bearer old', 'Bearer fresh']); expect(refreshed).toBe(1);
      const unified = await host.ctx.llmModel2Streaming.callUnifiedModel2StreamWithConfig(config, 0, {
        context: {}, chatHistory: [{ role: 'user', content: 'unified chat' }], subject: '',
        enableChainOfThought: false, enableThinking: false, taskContext: 'chat_v2', sink: { emit() {} },
        streamEvent: 'chat_v2_event_codex-unified', disableTools: true,
      });
      expect(unified).toMatchObject({ assistant_message: 'authenticated', cancelled: false });
      expect(authHeaders).toEqual(['Bearer old', 'Bearer fresh', 'Bearer fresh']);
      expect(refreshed).toBe(1);
      const ocrCandidates = await host.ctx.llmOcrHedge.prepareCandidates('data:image/png;base64,aW1hZ2U=',
        [{ kind: 'remote', config, engineType: 'generic_vlm' }], null);
      expect(ocrCandidates).toHaveLength(1);
      expect(ocrCandidates[0]).toMatchObject({ kind: 'remote', request: { isCodex: true } });
      expect(await host.ctx.llmOcrHedge.runPrepared(ocrCandidates)).toBe('authenticated');
      expect(refreshed).toBe(1);
      expect(await host.invoke('test_api_connection', { apiKey: '', apiBase: config.baseUrl, model: 'gpt-5',
        providerType: 'openai_codex', authMode: 'openai_codex_oauth' })).toMatchObject({ ok: true });
      expect(authHeaders.at(-1)).toBe('Bearer fresh');
      vi.spyOn(host.ctx.llm, 'getModel2Config').mockResolvedValue(config);
      expect(await host.invoke('call_llm_for_boundary', { prompt: 'find boundary' })).toMatchObject({
        assistant_message: 'authenticated', input_tokens: 0, output_tokens: 0,
      });
      vi.spyOn(host.ctx.llm, 'getTranslationModelConfig').mockResolvedValue(config);
      expect(await host.ctx.llmRag.translateText('hello', 'en', 'zh', null)).toBe('authenticated');
      const essay = createEssayTransport(host.ctx.llm, () => host.ctx.llmAdapters.createAdapter('openai_responses'), fetch, undefined, host.ctx.llmCodexAuth);
      const essayChunks: string[] = [];
      expect(await essay({ config, apiKey: '', systemPrompt: 'grade', userPrompt: 'essay', streamEvent: 'codex-essay',
        essayImages: [], topicImages: [], signal: new AbortController().signal }, text => essayChunks.push(text))).toBe('completed');
      expect(essayChunks.join('')).toBe('authenticated');
      expect(await host.invoke('translate_text_stream', { request: { session_id: 'codex-translation', text: 'hello', src_lang: 'en', tgt_lang: 'zh' } }))
        .toMatchObject({ translated_text: 'authenticated' });
      await host.invoke('openai_codex_logout');
      expect(await store.hasUsableCodexSession()).toBe(false);
    } finally { vi.restoreAllMocks(); await host.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

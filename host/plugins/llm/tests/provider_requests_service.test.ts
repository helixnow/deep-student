import { describe, expect, it, vi } from 'vitest';
import { createTestHost } from './host.ts';
import plugin from '../index.ts';
import { OpenAIResponsesAdapter, prepareRemoteImages, setRemoteImageDownloader } from '../../llm-providers/api.ts';
import { fetchBinaryWithCache } from '../../../platform/net-policy/node.ts';
import { makeConfig } from './support.ts';

describe('post-adapter model2 request diagnostics', () => {
  it('awaits production remote-image validation before synchronous provider conversion', async () => {
    // Only the external image HTTP response is substituted; L01 SSRF/cache/rewrite and adapter run live.
    setRemoteImageDownloader(fetchBinaryWithCache);
    const fetchImage = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }));
    const host = await createTestHost({ plugins: [plugin], provide: { settings: {}, secrets: {},
      llmAdapters: { createAdapter: () => new OpenAIResponsesAdapter(), prepareRemoteImages },
    } });
    try {
      const config = makeConfig({ model: 'gpt-4.1', apiProtocol: 'openai_responses' });
      const body = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://8.8.8.8/l02-preparation.png' } }] }] };
      const prepared = await host.ctx.llmProviderRequests.prepareModel2Async(config, body, 'chat_v2_event_images', null, false);
      expect(prepared.request.body).toMatchObject({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,iVBORw==' }] }] });
      expect(fetchImage).toHaveBeenCalledTimes(1);
      expect(body.messages[0]!.content[0]!.image_url.url).toBe('https://8.8.8.8/l02-preparation.png');
      body.messages[0]!.content[0]!.image_url.url = 'http://10.0.0.8/private.png';
      // fetch.rs returns None on SSRF denial; Responses retains the URL, rather than throwing.
      await host.ctx.llmProviderRequests.prepareModel2Async(config, body, 'chat_v2_event_images', null, false);
      expect(fetchImage).toHaveBeenCalledTimes(1);
    } finally { fetchImage.mockRestore(); setRemoteImageDownloader(null); await host.dispose(); }
  });

  it('keeps DeepSeek normalization and stable session identity in asynchronous production preparation', async () => {
    const host = await createTestHost({ plugins: [plugin], provide: { settings: {}, secrets: {} } });
    try {
      const config = makeConfig({ model: 'deepseek-v4', modelAdapter: 'deepseek', apiProtocol: 'openai_chat_completions', baseUrl: 'https://relay.example/v1' });
      const body = { model: config.model, max_completion_tokens: 128, messages: [{ role: 'system', content: [{ type: 'text', text: 'stable' }] }], stream: true };
      const result = await host.ctx.llmProviderRequests.prepareModel2Async(config, body, 'chat_v2_event_session_run_1', null, false);
      expect(result.request.body).toMatchObject({ max_tokens: 128, messages: [{ role: 'system', content: 'stable' }] });
      expect(result.codexRequest).toBeNull();
      // providers/mod.rs:3958: OpenAI Chat also requires an explicit terminal event.
      expect(result.requiresExplicitStreamCompletion).toBe(true);
      expect(body).toHaveProperty('max_completion_tokens', 128);
    } finally { await host.dispose(); }
  });
  it('logs same session/variant across runs and keeps the disabled-debug request identical', async () => {
    const logs: string[] = [];
    const logger = { info: (text: string) => logs.push(text), debug: () => {}, warn: () => {}, error: () => {} };
    const host = await createTestHost({ plugins: [plugin], provide: { settings: {}, secrets: {},
      llmAdapters: { createAdapter: () => new OpenAIResponsesAdapter() }, log: { logger: () => logger },
    } });
    try {
      logs.length = 0;
      const config = makeConfig({ model: 'gpt-4.1', baseUrl: 'https://api.openai.com/v1', apiProtocol: 'openai_responses' });
      const body = { model: config.model, messages: [{ role: 'system', content: 'stable' }, { role: 'user', content: 'first' }], stream: true };
      const original = structuredClone(body);
      const service = host.ctx.llmProviderRequests;
      const first = service.prepareModel2(config, body, 'chat_v2_event_cache-test_var_variant_run_1', null, true);
      expect(first.request.body).toHaveProperty('input');
      expect(first.requiresExplicitStreamCompletion).toBe(true);
      expect(logs[0]).toContain('scope=cache-test::variant');
      expect(logs[0]).toContain('first_divergent_segment=baseline');
      const second = service.prepareModel2(config, body, 'chat_v2_event_cache-test_var_variant_run_2', null, true);
      expect(second.request).toEqual(first.request);
      expect(logs[2]).toContain('first_divergent_segment=none');
      body.messages[1]!.content = 'second';
      service.prepareModel2(config, body, 'chat_v2_event_cache-test_var_variant_run_3', null, true);
      expect(logs[4]).toContain('first_divergent_segment=current_user');
      const count = logs.length;
      const quiet = service.prepareModel2(config, original, 'chat_v2_event_cache-test_var_variant_run_4', null, false);
      expect(quiet.request).toEqual(first.request);
      expect(logs).toHaveLength(count);
      expect(body.messages[0]).toEqual(original.messages[0]);
    } finally { await host.dispose(); }
  });
});

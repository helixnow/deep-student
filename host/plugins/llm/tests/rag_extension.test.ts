import { describe, expect, it } from 'vitest';
import { makeConfig } from './support.ts';
import { ragTranslationRequestBody } from '../src/rag_extension.ts';
import { createTestHost } from './host.ts';
import plugin from '../index.ts';
import { OpenAIAdapter } from '../../llm-providers/api.ts';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';

describe('rag_extension.rs', () => {
  it('rag_translation_request_uses_model_and_provider_token_limits', () => {
    const limited = makeConfig({ maxOutputTokens: 40_000, maxTokensLimit: 24_000 });
    expect(ragTranslationRequestBody(limited, []).max_tokens).toBe(24_000);

    const unlimited = makeConfig({ maxOutputTokens: 12_000, maxTokensLimit: null });
    expect(ragTranslationRequestBody(unlimited, []).max_tokens).toBe(12_000);
  });

  it('executes the published RAG translation with the original prompts, budgets and HTTP errors', async () => {
    let status = 200;
    let payload = JSON.stringify({ choices: [{ message: { content: '译文' } }] });
    const seen: Record<string, unknown>[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      seen.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.writeHead(status, { 'content-type': 'application/json' }); response.end(payload);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const host = await createTestHost({ plugins: [plugin], provide: {
      settings: { get: () => null }, secrets: {}, llmAdapters: { createAdapter: () => new OpenAIAdapter() },
    } });
    try {
      vi.spyOn(host.ctx.llm, 'getTranslationModelConfig').mockResolvedValue(makeConfig({
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        model: 'translate', maxOutputTokens: 40_000, maxTokensLimit: 24_000,
      }));
      vi.spyOn(host.ctx.llm, 'decryptApiKey').mockResolvedValue('key');
      expect(await host.ctx.llmRag.translateText('hello', 'en', 'zh', null)).toBe('译文');
      expect(seen[0]).toMatchObject({ model: 'translate', temperature: 0.3, max_tokens: 24_000, stream: false });
      expect(seen[0]?.messages).toMatchObject([{ role: 'system' }, { role: 'user', content: expect.stringContaining('hello') }]);
      for (const [code, message] of [[401, 'API 密钥无效或已过期，请检查设置'], [403, 'API 访问被拒绝，请检查账户权限'],
        [429, '请求过于频繁，请稍后重试'], [503, '翻译服务暂时不可用，请稍后重试'], [400, '翻译请求失败，请重试']] as const) {
        status = code; payload = 'upstream secret';
        await expect(host.ctx.llmRag.translateText('hello', 'en', 'zh', null)).rejects.toMatchObject({ error_type: 'LLM', message });
      }
      status = 200; payload = JSON.stringify({ choices: [{ message: { content: null } }] });
      await expect(host.ctx.llmRag.translateText('hello', 'en', 'zh', null)).rejects.toMatchObject({ message: '翻译响应中未找到内容' });
      expect(seen).toHaveLength(7);
    } finally {
      await host.dispose(); vi.restoreAllMocks();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

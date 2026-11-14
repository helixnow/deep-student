import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost } from './host.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type { VendorConfig } from '../api.ts';
import llm from '../index.ts';
import { defaultVendorConfig } from '../src/config_store.ts';
import {
  fetchVendorModels, parseVendorModelsPage, probeU32Field, vendorModelHeaders,
  vendorModelsEndpoint,
} from '../src/vendor_models.ts';

const hosts: Awaited<ReturnType<typeof createTestHost>>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose(); });

function vendor(overrides: Partial<VendorConfig>): VendorConfig {
  return { ...defaultVendorConfig(), baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', ...overrides };
}

describe('commands.rs::vendor_models_endpoint', () => {
  it('derives gemini, anthropic and openai endpoints from the configured path', () => {
    expect(vendorModelsEndpoint('https://generativelanguage.googleapis.com', 'gemini', null).url.href)
      .toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(vendorModelsEndpoint('https://generativelanguage.googleapis.com/v1beta', 'google', null).url.href)
      .toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(vendorModelsEndpoint('https://api.anthropic.com/v1/messages', 'anthropic', null).url.href)
      .toBe('https://api.anthropic.com/v1/models');
    expect(vendorModelsEndpoint('https://api.openai.com/v1/chat/completions', 'openai', null).url.href)
      .toBe('https://api.openai.com/v1/models');
    expect(vendorModelsEndpoint('https://gateway.example.com/custom/responses', 'openai', null).url.href)
      .toBe('https://gateway.example.com/custom/models');
  });

  it('keeps OpenAI-compatible roots when the protocol explicitly selects openai', () => {
    const { url, kind } = vendorModelsEndpoint('https://api.openai.com/v1', 'gemini', 'openai_responses');
    expect(kind).toBe('openai');
    expect(url.href).toBe('https://api.openai.com/v1/models');
  });

  it('normalizes the Ollama root base url to /v1', () => {
    expect(vendorModelsEndpoint('http://127.0.0.1:11434', 'ollama', null).url.href)
      .toBe('http://127.0.0.1:11434/v1/models');
  });

  it('rejects invalid base urls with the Rust validation messages', () => {
    expect(() => vendorModelsEndpoint('not a url', 'openai', null))
      .toThrow('供应商 Base URL 无效');
    expect(() => vendorModelsEndpoint('ftp://example.com', 'openai', null))
      .toThrow('供应商 Base URL 必须是有效的 HTTP(S) 地址');
  });
});

describe('commands.rs::vendor_model_headers', () => {
  it('adds protocol headers and keeps custom headers unless hop-by-hop', () => {
    expect(vendorModelHeaders(vendor({ headers: { 'X-Trace': '1', Host: 'evil' } }), 'openai'))
      .toEqual([['X-Trace', '1'], ['Authorization', 'Bearer sk-test']]);
    expect(vendorModelHeaders(vendor({}), 'gemini')).toEqual([
      ['x-goog-api-key', 'sk-test'],
    ]);
    expect(vendorModelHeaders(vendor({ apiKey: '' }), 'anthropic')).toEqual([
      ['anthropic-version', '2023-06-01'],
    ]);
  });

  it('rejects invalid header names and values', () => {
    expect(() => vendorModelHeaders(vendor({ headers: { 'bad header': '1' } }), 'openai'))
      .toThrow('无效的供应商请求头名称: bad header');
    expect(() => vendorModelHeaders(vendor({ headers: { 'X-Trace': 'bad\u0001' } }), 'openai'))
      .toThrow('供应商请求头包含无效字符');
  });
});

describe('commands.rs::probe_u32_field', () => {
  it('reads integers and numeric strings, ignoring zero and overflow', () => {
    expect(probeU32Field({ context_length: 128_000 }, ['context_length'])).toBe(128_000);
    expect(probeU32Field({ context_length: ' 64000 ' }, ['context_length'])).toBe(64_000);
    expect(probeU32Field({ context_length: 0, max_context_length: 4096 }, ['context_length', 'max_context_length'])).toBe(4096);
    expect(probeU32Field({ context_length: 2 ** 40 }, ['context_length'])).toBeNull();
    expect(probeU32Field({ top_provider: { max_completion_tokens: 8192 } }, ['top_provider.max_completion_tokens'])).toBe(8192);
  });
});

describe('commands.rs::parse_vendor_models_page', () => {
  it('filters gemini models and maps quota fields', () => {
    const parsed = parseVendorModelsPage({
      models: [
        { name: 'models/gemini-3-pro', displayName: 'Gemini 3 Pro', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1_000_000, outputTokenLimit: 65_536 },
        { name: 'models/embedding-1', supportedGenerationMethods: ['embedContent'] },
      ],
      nextPageToken: 'next',
    }, 'gemini');
    expect([...parsed.models.values()]).toEqual([{
      id: 'gemini-3-pro', label: 'Gemini 3 Pro', contextWindow: 1_000_000, maxOutputTokens: 65_536,
    }]);
    expect(parsed.cursor).toBe('next');
  });

  it('filters openai audio models and reads pagination cursors', () => {
    const parsed = parseVendorModelsPage({
      data: [
        { id: 'gpt-5.4-mini', display_name: 'GPT-5.4 Mini', context_length: 400_000 },
        { id: 'gpt-tts-1' },
      ],
      has_more: true,
      last_id: 'gpt-5.4-mini',
    }, 'openai');
    expect([...parsed.models.keys()]).toEqual(['gpt-5.4-mini']);
    expect(parsed.cursor).toBe('gpt-5.4-mini');
  });

  it('skips anthropic items whose type is not model', () => {
    const parsed = parseVendorModelsPage({
      data: [
        { id: 'claude-sonnet-5', type: 'model', display_name: 'Claude Sonnet 5', max_output_tokens: 64_000 },
        { id: 'other', type: 'tool' },
      ],
    }, 'anthropic');
    expect([...parsed.models.values()]).toEqual([
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', contextWindow: null, maxOutputTokens: 64_000 },
    ]);
    expect(parsed.cursor).toBeNull();
  });

  it('requires the protocol container arrays', () => {
    expect(() => parseVendorModelsPage({}, 'gemini')).toThrow('Gemini 模型响应缺少 models 数组');
    expect(() => parseVendorModelsPage({}, 'openai')).toThrow('供应商模型响应缺少 data 数组');
  });
});

describe('commands.rs::fetch_vendor_models', () => {
  it('returns the builtin OpenCode Go catalog without any network call', async () => {
    let calls = 0;
    const models = await fetchVendorModels(vendor({ id: 'builtin-opencode-go', providerType: 'opencode_go' }), {
      fetch: async () => { calls += 1; throw new Error('network must not be used'); },
    });
    expect(calls).toBe(0);
    expect(models.length).toBe(13);
    expect(models[0]?.id).toBe('deepseek-v4.1-flash');
    expect(models.every((model) => model.maxOutputTokens !== null)).toBe(true);
  });

  it('falls back to a backup key and paginates until the cursor is empty', async () => {
    const requests: string[] = [];
    const responses = [
      { status: 200, statusText: 'OK', json: async () => ({ data: [{ id: 'b-model', context_window: 8192 }], has_more: true, last_id: 'b-model' }), text: async () => '' },
      { status: 200, statusText: 'OK', json: async () => ({ data: [{ id: 'a-model', max_output_tokens: 1024 }] }), text: async () => '' },
    ];
    const models = await fetchVendorModels(vendor({ apiKey: '', apiKeys: [' backup-key '] }), {
      fetch: async (url, init) => {
        requests.push(url);
        expect(init.headers).toContainEqual(['Authorization', 'Bearer backup-key']);
        expect(init.redirect).toBe('manual');
        return responses.shift()!;
      },
    });
    expect(models.map((model) => model.id)).toEqual(['a-model', 'b-model']);
    expect(requests).toEqual([
      'https://api.example.com/v1/models',
      'https://api.example.com/v1/models?after=b-model',
    ]);
  });

  it('reports HTTP failures and truncates the body like Rust', async () => {
    await expect(fetchVendorModels(vendor({ apiKey: '' }), {
      fetch: async () => ({
        status: 401, statusText: 'Unauthorized', json: async () => ({}),
        text: async () => 'x'.repeat(3000),
      }),
    })).rejects.toThrow('供应商尚未配置 API 密钥');

    await expect(fetchVendorModels(vendor({}), {
      fetch: async () => ({
        status: 401, statusText: 'Unauthorized', json: async () => ({}),
        text: async () => 'x'.repeat(3000),
      }),
    })).rejects.toMatchObject({
      error_type: 'Network',
      message: `获取供应商模型失败: 401 Unauthorized - ${'x'.repeat(2048)}`,
    });
  });

  it('is registered and returns the builtin catalog through the command boundary', async () => {
    const settings: SettingsStore = {
      get: () => null, save: () => {}, delete: () => false,
      listByPrefix: () => [], deleteByPrefix: () => 0,
      getSecret: async () => null, saveSecret: async () => {}, deleteSecret: async () => false,
    };
    const host = await createTestHost({
      plugins: [llm],
      provide: {
        settings,
        secrets: { isEncryptedFormat: () => false, openCrypto: async () => { throw new Error('unused'); } },
      },
    });
    hosts.push(host);
    const models = await host.invoke<{ id: string }[]>('fetch_vendor_models', { vendorId: ' builtin-opencode-go ' });
    expect(models.length).toBe(13);
  });
});

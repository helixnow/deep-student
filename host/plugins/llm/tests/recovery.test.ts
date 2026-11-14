import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost } from './host.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type { CryptoService, EncryptedData } from '../../../platform/secrets/api.ts';
import llm from '../index.ts';
import { createDefaultApiConfigs, createDefaultModelAssignments } from '../src/config_recovery.ts';

const hosts: Awaited<ReturnType<typeof createTestHost>>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose(); });

function encryptApiKey(value: string): EncryptedData {
  return { ciphertext: Buffer.from(value, 'utf8').toString('base64'), nonce: '', version: 2 };
}
const crypto = {
  encryptApiKey,
  decryptApiKey(data: EncryptedData): string {
    return Buffer.from(data.ciphertext, 'base64').toString('utf8');
  },
  migratePlaintextKey(value: string): string {
    return JSON.stringify(encryptApiKey(value));
  },
  verifyKeyIntegrity: () => true,
} as unknown as CryptoService;

function secretsStub() {
  return {
    isEncryptedFormat: (value: string) => value.trim().startsWith('{'),
    openCrypto: async () => crypto,
  };
}

function memorySettings(): SettingsStore {
  const plain = new Map<string, string>();
  const secrets = new Map<string, string>();
  return {
    get: (key: string) => plain.get(key) ?? null,
    save: (key: string, value: string) => { plain.set(key, value); },
    delete: (key: string) => plain.delete(key),
    listByPrefix: () => [],
    deleteByPrefix: () => 0,
    getSecret: async (key: string) => secrets.get(key) ?? null,
    saveSecret: async (key: string, value: string) => { secrets.set(key, value); },
    deleteSecret: async (key: string) => secrets.delete(key),
  } as SettingsStore;
}

describe('config_recovery.rs', () => {
  it('create_default_api_configs matches the Rust defaults', () => {
    const configs = createDefaultApiConfigs();
    expect(configs.map((config) => config.id)).toEqual(['openai-gpt4', 'claude-sonnet']);
    const openai = configs[0]!;
    expect(openai.model).toBe('gpt-5.4-mini');
    expect(openai.providerType).toBe('openai');
    expect(openai.apiProtocol).toBe('openai_responses');
    expect(openai.supportsOpenaiResponses).toBe(true);
    expect(openai.enabled).toBe(false);
    expect(openai.contextWindow).toBe(400_000);
    expect(openai.verbosity).toBe('medium');
    expect(openai.maxOutputTokens).toBe(32_768);

    const claude = configs[1]!;
    expect(claude.model).toBe('claude-sonnet-5');
    expect(claude.providerType).toBe('anthropic');
    expect(claude.apiProtocol).toBe('anthropic_messages');
    expect(claude.supportsOpenaiResponses).toBe(false);
    expect(claude.enabled).toBe(false);
    expect(claude.contextWindow).toBe(1_000_000);
    expect(claude.thinkingEnabled).toBe(false);
  });

  it('create_default_model_assignments clears every slot', () => {
    const assignments = createDefaultModelAssignments();
    for (const value of Object.values(assignments)) expect(value).toBeNull();
    expect(Object.keys(assignments).length).toBe(17);
  });

  it('restore_default_api_configs writes the defaults and returns the Rust message', async () => {
    const settings = memorySettings();
    const host = await createTestHost({ plugins: [llm], provide: { settings, secrets: secretsStub() } });
    hosts.push(host);

    const message = await host.invoke<string>('restore_default_api_configs');
    expect(message).toBe('✅ 默认API配置已恢复！请填入您的API密钥并启用相应配置。');

    const configs = await host.invoke<{ id: string; enabled: boolean }[]>('get_api_configurations');
    const restored = configs.filter((config) => config.id === 'claude-sonnet' || config.id === 'openai-gpt4');
    expect(restored.map((config) => config.id).sort()).toEqual(['claude-sonnet', 'openai-gpt4']);
    // Rust 的 get_api_configs 也会合并内置目录，因此 enabled_count 中仍只有这两个用户配置为 false。
    expect(restored.every((config) => config.enabled === false)).toBe(true);

    const assignments = await host.invoke<Record<string, unknown>>('get_model_assignments');
    expect(assignments.model2_config_id).toBeNull();
    expect(assignments.translation_display_mode).toBeNull();
  });

  it('check_api_config_status reports counts and recovery need', async () => {
    const settings = memorySettings();
    const host = await createTestHost({ plugins: [llm], provide: { settings, secrets: secretsStub() } });
    hosts.push(host);

    const empty = await host.invoke<Record<string, unknown>>('check_api_config_status');
    const baseline = empty.config_count as number;
    expect(baseline).toBeGreaterThan(0); // builtin catalog 始终参与合并，与 Rust 相同
    expect(empty).toEqual({
      config_count: baseline,
      enabled_count: 0,
      has_assignments: false,
      needs_recovery: false,
    });

    await host.invoke('restore_default_api_configs');
    await host.invoke('save_model_assignments', { assignments: { model2_config_id: 'openai-gpt4' } });
    const restored = await host.invoke<Record<string, unknown>>('check_api_config_status');
    // save_api_configurations 会像 Rust 一样隐藏本次未提交的内置模型条目，只剩两条默认配置。
    expect(restored).toEqual({
      config_count: 2,
      enabled_count: 0,
      has_assignments: true,
      needs_recovery: false,
    });
  });
});

describe('llm@1 service', () => {
  it('get_translation_model_config rejects a disabled translation assignment', async () => {
    const settings = memorySettings();
    const host = await createTestHost({ plugins: [llm], provide: { settings, secrets: secretsStub() } });
    hosts.push(host);
    await host.invoke('restore_default_api_configs');
    await host.invoke('save_model_assignments', {
      assignments: {
        model2_config_id: 'openai-gpt4',
        translation_model_config_id: 'claude-sonnet',
      },
    });
    await expect(host.ctx.llm.getTranslationModelConfig()).rejects.toMatchObject({
      value: { error_type: 'Configuration', message: '翻译模型已禁用或不支持文本调用' },
    });
  });

  it('get_translation_model_config reports the Rust errors when nothing is assigned', async () => {
    const settings = memorySettings();
    const host = await createTestHost({ plugins: [llm], provide: { settings, secrets: secretsStub() } });
    hosts.push(host);
    await expect(host.ctx.llm.getTranslationModelConfig()).rejects.toMatchObject({
      value: { error_type: 'Configuration', message: '未配置翻译模型或model2' },
    });
  });

  it('call_llm_for_boundary returns assistant_message and zero token placeholders', async () => {
    const settings = memorySettings();
    const host = await createTestHost({ plugins: [llm], provide: { settings, secrets: secretsStub() } });
    hosts.push(host);
    await host.invoke('restore_default_api_configs');
    const configs = await host.invoke<{ id: string; enabled: boolean; apiKey: string }[]>('get_api_configurations');
    const restored = configs.filter((config) => config.id === 'openai-gpt4' || config.id === 'claude-sonnet');
    for (const config of restored) {
      config.enabled = true;
      config.apiKey = 'sk-test';
    }
    await host.invoke('save_api_configurations', { configs: restored });
    await host.invoke('save_model_assignments', { assignments: { model2_config_id: 'openai-gpt4' } });
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: { body: string }) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) as Record<string, unknown> });
      return new Response(JSON.stringify({
        output: [{ content: [{ type: 'output_text', text: '{"cut":1}' }] }],
      }), { status: 200, statusText: 'OK' });
    }) as unknown as typeof fetch;
    try {
      const result = await host.invoke<Record<string, unknown>>('call_llm_for_boundary', { prompt: 'find boundary' });
      expect(result).toEqual({ assistant_message: '{"cut":1}', input_tokens: 0, output_tokens: 0 });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://api.openai.com/v1/responses');
    expect(requests[0]!.body).toMatchObject({
      model: 'gpt-5.4-mini',
      stream: false,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'find boundary' }] }],
    });
  });
});

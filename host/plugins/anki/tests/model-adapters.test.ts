import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { AdapterInfo } from '../src/model-adapters.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

const ADAPTER_INFOS: AdapterInfo[] = [
  { value: 'general', label: 'General', description: 'Generic request adapter' },
  { value: 'qwen', label: 'Qwen', description: 'Qwen adapter' },
];

const DEFAULTS = [
  { value: 'general', label: 'General', description: 'Generic request adapter', is_default: true },
  { value: 'qwen', label: 'Qwen', description: 'Qwen adapter', is_default: true },
];

describe('src/cmd/anki_cards.rs::model_adapter_options', () => {
  let env: AnkiTestEnv;
  let db: DatabaseHandle;

  beforeAll(async () => {
    env = await createAnkiTestEnv({
      provide: { llmAdapterInfos: { listAdapterInfos: () => [...ADAPTER_INFOS] } },
    });
    db = env.storage.database('mistakes');
  }, 120_000);

  afterAll(async () => {
    await env.dispose();
  });

  it('get_model_adapter_options_projects_registry_infos', async () => {
    expect(await env.host.invoke('get_model_adapter_options')).toEqual(DEFAULTS);
    // Rust 命令不读数据库缓存，始终返回注册表的默认投影
    db.run("DELETE FROM settings WHERE key = 'model_adapter_options'");
    expect(await env.host.invoke('get_model_adapter_options')).toEqual(DEFAULTS);
  });

  it('save_model_adapter_options_validates_and_persists_json', async () => {
    const custom = [
      { value: 'custom', label: 'Custom', description: 'Custom option' },
    ];
    await expect(env.host.invoke('save_model_adapter_options', { options: custom })).resolves.toBeNull();
    expect(db.one<{ value: string }>("SELECT value FROM settings WHERE key = 'model_adapter_options'")).toEqual({
      value: JSON.stringify(custom),
    });

    await expect(env.host.invoke('save_model_adapter_options', {
      options: [{ value: 'missing-label' }],
    })).rejects.toMatchObject({
      error_type: 'Validation',
      message: "模型适配器选项 0 格式无效，必须包含 'value' 和 'label' 字段",
    });
    await expect(env.host.invoke('save_model_adapter_options', {
      options: ['not-an-object'],
    })).rejects.toMatchObject({
      error_type: 'Validation',
      message: "模型适配器选项 0 格式无效，必须包含 'value' 和 'label' 字段",
    });
  });

  it('reset_model_adapter_options_returns_and_persists_defaults', async () => {
    await env.host.invoke('save_model_adapter_options', {
      options: [{ value: 'custom', label: 'Custom' }],
    });
    await expect(env.host.invoke('reset_model_adapter_options')).resolves.toEqual(DEFAULTS);
    expect(db.one<{ value: string }>("SELECT value FROM settings WHERE key = 'model_adapter_options'")).toEqual({
      value: JSON.stringify(DEFAULTS),
    });
  });
});

describe('src/cmd/anki_cards.rs::model_adapter_options_without_registry', () => {
  it('fails_with_configuration_error_when_L02_registry_is_absent', async () => {
    const env = await createAnkiTestEnv();
    try {
      await expect(env.host.invoke('get_model_adapter_options')).rejects.toMatchObject({
        error_type: 'Configuration',
        message: '模型适配器注册表不可用',
      });
      await expect(env.host.invoke('reset_model_adapter_options')).rejects.toMatchObject({
        error_type: 'Configuration',
        message: '模型适配器注册表不可用',
      });
    } finally {
      await env.dispose();
    }
  });
});

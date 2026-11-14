import { describe, expect, it, vi } from 'vitest';
import { createTestHost } from './host.ts';
import plugin from '../index.ts';
import { makeConfig } from './support.ts';
import { createOcrModelsService } from '../src/ocr_models_service.ts';
import type { ApiConfig__De, LLMManager } from '../api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';

describe('OCR model service (mod.rs:7006–7709)', () => {
  it('publishes the live settings candidate resolver and preserves disabled fallback semantics', async () => {
    const values = new Map<string, string>();
    values.set('ocr.available_models', JSON.stringify([{ configId: 'vision', model: 'vision', engineType: 'generic_vlm', name: 'Vision' }]));
    const host = await createTestHost({ plugins: [plugin], provide: {
      settings: { get: (key: string) => values.get(key) ?? null, save: (key: string, value: string) => values.set(key, value) },
      secrets: {},
    } });
    try {
      const config = makeConfig({ id: 'vision', model: 'vision', isMultimodal: true, enabled: true });
      vi.spyOn(host.ctx.llm, 'getApiConfigs').mockResolvedValue([config]);
      const ocr = host.ctx.llmOcrModels;
      expect(await ocr.inspectFreeTextOcrAvailable()).toBe(true);
      expect(await ocr.getOcrConfigsByPriority('Structured')).toEqual([[config, 'generic_vlm']]);
      config.enabled = false;
      // Rust's single-model selector intentionally does not enforce enabled.
      expect(await ocr.getOcrModelConfig()).toEqual(config);
      expect(await ocr.inspectFreeTextOcrAvailable()).toBe(false);
      expect(await ocr.getOcrConfigWithEffectiveEngine()).toEqual([config, 'generic_vlm']);
    } finally { await host.dispose(); vi.restoreAllMocks(); }
  });

  it('migrates GLM/Paddle and legacy priority, including best-effort writes, in Rust order', async () => {
    const models = [
      { configId: 'glm', model: 'THUDM/GLM-4.1V-9B-Thinking', engineType: 'glm4v_ocr', name: 'GLM-4.1V', priority: 0 },
      { configId: 'paddle', model: 'PaddlePaddle/PaddleOCR-VL', engineType: 'paddle_ocr_vl', name: 'PaddleOCR-VL', priority: 0 },
      { configId: 'old', model: 'PaddlePaddle/PaddleOCR-VL', engineType: 'paddle_ocr_vl_v1', name: 'Old', priority: 0 },
    ];
    const values = new Map([['ocr.available_models', JSON.stringify(models)], ['ocr.engine_type', 'paddle_ocr_vl']]);
    const order: string[] = [];
    const configs = [makeConfig({ id: 'glm', model: 'THUDM/GLM-4.1V-9B-Thinking', name: 'GLM-4.1V', baseUrl: 'https://api.siliconflow.cn/v1' })];
    const save = vi.fn(async (_configs: ApiConfig__De[]) => { order.push('api'); throw new Error('read only'); });
    const ocr = createOcrModelsService({ get: (key: string) => values.get(key) ?? null,
      save: () => { order.push('settings'); throw new Error('read only'); } } as unknown as SettingsStore,
    { getApiConfigs: async () => structuredClone(configs), saveApiConfigurations: save } as unknown as LLMManager, () => false);
    const result = await ocr.getAvailableOcrModels();
    expect(result.map(item => [item.config_id, item.model, item.priority])).toEqual([
      ['paddle', 'PaddlePaddle/PaddleOCR-VL-1.5', 0], ['glm', 'Qwen/Qwen3-VL-8B-Instruct', 1], ['old', 'PaddlePaddle/PaddleOCR-VL', 2],
    ]);
    expect(result.find(item => item.config_id === 'glm')?.engine_type).toBe('generic_vlm');
    expect(save.mock.calls[0]?.[0]).toMatchObject([{ model: 'Qwen/Qwen3-VL-8B-Instruct', name: 'Qwen3-VL-8B' }]);
    expect(order).toEqual(['api', 'settings']);
    expect(configs[0]?.model).toBe('THUDM/GLM-4.1V-9B-Thinking');
  });
});

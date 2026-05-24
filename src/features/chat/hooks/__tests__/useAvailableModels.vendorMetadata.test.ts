import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearModelsCache, ensureModelsCacheLoaded } from '../useAvailableModels';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

describe('useAvailableModels vendor metadata', () => {
  beforeEach(() => {
    clearModelsCache();
    invokeMock.mockReset();
  });

  it('preserves vendor metadata from API configurations', async () => {
    invokeMock.mockResolvedValueOnce([
      {
        id: 'deepseek-v32-siliconflow',
        name: 'DeepSeek V3.2',
        model: 'deepseek-ai/DeepSeek-V3.2',
        vendorId: 'builtin-siliconflow',
        vendorName: 'SiliconFlow',
        providerType: 'openai-compatible',
        enabled: true,
      },
    ]);

    const models = await ensureModelsCacheLoaded(true);

    expect(models[0]).toMatchObject({
      id: 'deepseek-v32-siliconflow',
      model: 'deepseek-ai/DeepSeek-V3.2',
      vendorId: 'builtin-siliconflow',
      vendorName: 'SiliconFlow',
    });
  });
});

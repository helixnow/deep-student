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
        isReasoning: false,
        supportsReasoning: true,
        enabled: true,
      },
    ]);

    const models = await ensureModelsCacheLoaded(true);

    expect(models[0]).toMatchObject({
      id: 'deepseek-v32-siliconflow',
      model: 'deepseek-ai/DeepSeek-V3.2',
      vendorId: 'builtin-siliconflow',
      vendorName: 'SiliconFlow',
      isReasoning: false,
      supportsReasoning: true,
    });
  });

  it('filters blank model rows and deduplicates by id and (vendorId, model) while keeping distinct vendors (G22)', async () => {
    invokeMock.mockResolvedValueOnce([
      { id: 'blank-1', name: 'Untitled', model: '   ', vendorId: 'v-a', vendorName: 'Vendor A', enabled: true },
      { id: 'm-1', name: '  ', model: 'gpt-4o', vendorId: 'v-a', vendorName: 'Vendor A', enabled: true },
      { id: 'm-1', name: 'Dup Same Id', model: 'gpt-4o', vendorId: 'v-a', vendorName: 'Vendor A', enabled: true },
      { id: 'm-2', name: 'Dup Same Vendor Model', model: ' GPT-4O ', vendorId: 'v-a', vendorName: 'Vendor A', enabled: true },
      { id: 'm-3', name: 'Other Vendor GPT-4o', model: 'gpt-4o', vendorId: 'v-b', vendorName: 'Vendor B', enabled: true },
    ]);

    const models = await ensureModelsCacheLoaded(true);

    expect(models.map((m) => ({ id: m.id, name: m.name, model: m.model, vendorId: m.vendorId }))).toEqual([
      { id: 'm-1', name: 'gpt-4o', model: 'gpt-4o', vendorId: 'v-a' },
      { id: 'm-3', name: 'Other Vendor GPT-4o', model: 'gpt-4o', vendorId: 'v-b' },
    ]);
  });
});

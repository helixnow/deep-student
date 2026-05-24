import { describe, expect, it } from 'vitest';
import {
  sortApiConfigsByVendorOrder,
  sortUnifiedModelInfosForSelector,
} from '@/utils/modelSorting';
import type { ApiConfig, VendorConfig } from '@/types';

const vendor = (
  id: string,
  name: string,
  providerType: string,
  sortOrder?: number
): VendorConfig => ({
  id,
  name,
  providerType,
  baseUrl: '',
  apiKey: '',
  sortOrder,
});

const api = (
  id: string,
  vendorId: string,
  model: string,
  isFavorite = false
): ApiConfig => ({
  id,
  name: model,
  vendorId,
  vendorName: vendorId,
  providerType: vendorId,
  apiKey: '',
  baseUrl: '',
  model,
  isMultimodal: false,
  isReasoning: false,
  isEmbedding: false,
  isReranker: false,
  enabled: true,
  modelAdapter: 'openai',
  isFavorite,
});

describe('settings model sorting', () => {
  it('orders model assignment options by vendor order before favorite status', () => {
    const vendors = [
      vendor('qwen', 'Qwen', 'qwen', 2),
      vendor('deepseek', 'DeepSeek', 'deepseek', 1),
      vendor('siliconflow', 'SiliconFlow', 'siliconflow'),
    ];
    const apis = [
      api('qwen-favorite', 'qwen', 'qwen-plus', true),
      api('deepseek-normal', 'deepseek', 'deepseek-chat'),
      api('siliconflow-normal', 'siliconflow', 'deepseek-ai/DeepSeek-V3'),
      api('deepseek-favorite', 'deepseek', 'deepseek-reasoner', true),
    ];

    expect(sortApiConfigsByVendorOrder(apis, vendors).map((item) => item.id)).toEqual([
      'siliconflow-normal',
      'deepseek-favorite',
      'deepseek-normal',
      'qwen-favorite',
    ]);
  });

  it('keeps disabled current selections in their provider group', () => {
    const vendors = [
      vendor('openai', 'OpenAI', 'openai', 1),
      vendor('deepseek', 'DeepSeek', 'deepseek', 0),
    ];
    const disabledCurrent = {
      ...api('openai-disabled-current', 'openai', 'gpt-4o'),
      enabled: false,
      _isDisabledInList: true,
    } as ApiConfig & { _isDisabledInList?: boolean };

    const sorted = sortApiConfigsByVendorOrder(
      [
        api('openai-enabled', 'openai', 'gpt-5.1'),
        api('deepseek-enabled', 'deepseek', 'deepseek-chat'),
        disabledCurrent,
      ],
      vendors
    );

    expect(sorted.map((item) => item.id)).toEqual([
      'deepseek-enabled',
      'openai-enabled',
      'openai-disabled-current',
    ]);
  });

  it('keeps selector favorites inside their vendor group', () => {
    const sorted = sortUnifiedModelInfosForSelector([
      { id: 'siliconflow-normal', vendorId: 'siliconflow', vendorSortOrder: 0, isFavorite: false },
      { id: 'deepseek-normal', vendorId: 'deepseek', vendorSortOrder: 1, isFavorite: false },
      { id: 'deepseek-favorite', vendorId: 'deepseek', vendorSortOrder: 1, isFavorite: true },
      { id: 'qwen-favorite', vendorId: 'qwen', vendorSortOrder: 2, isFavorite: true },
    ]);

    expect(sorted.map((item) => item.id)).toEqual([
      'siliconflow-normal',
      'deepseek-favorite',
      'deepseek-normal',
      'qwen-favorite',
    ]);
  });
});

/**
 * OpenCode Go 模型在选择器第二行显示当前套餐的官方预估请求数；其他供应商不显示。
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, settings } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  settings: new Map<string, string>(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@/utils/settingsApi', () => ({
  getSetting: vi.fn(async (key: string) => settings.get(key) ?? null),
  saveSetting: vi.fn(async (key: string, value: string) => {
    settings.set(key, value);
  }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      key === 'chatV2:modelPicker.openCodeGoRequests' ? `≈${options?.count}/5h` : key,
    i18n: { language: 'en-US' },
  }),
}));

import { ModelPicker } from '../ModelPicker';

const base = { enabled: true, isEmbedding: false, isReranker: false, supportsTools: true };
const CONFIGS = [
  {
    ...base,
    id: 'go-ds',
    name: 'DeepSeek V4.1 Flash (Go)',
    model: 'deepseek-v4.1-flash',
    vendorId: 'builtin-opencode-go',
    providerType: 'opencode_go',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
  },
  { ...base, id: 'ds', name: 'DeepSeek', model: 'deepseek-flash', vendorId: 'builtin-deepseek', baseUrl: 'https://api.deepseek.com/v1' },
];

describe('ModelPicker · OpenCode Go quota hint', () => {
  beforeEach(() => {
    settings.clear();
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_api_configurations') return CONFIGS;
      if (cmd === 'get_vendor_configs') {
        return [
          { id: 'builtin-opencode-go', name: 'OpenCode Go', providerType: 'opencode_go' },
          { id: 'builtin-deepseek', name: 'DeepSeek', providerType: 'deepseek' },
        ];
      }
      if (cmd === 'get_model_assignments') return {};
      return undefined;
    });
  });

  it('shows the estimated requests only for OpenCode Go models', async () => {
    render(<ModelPicker mode="single" onClose={() => {}} />);
    const hints = await screen.findAllByTestId('opencode-go-picker-quota');
    expect(hints).toHaveLength(1);
    expect(hints[0]).toHaveTextContent('≈43.3K/5h');
    const goRow = hints[0].closest('button');
    expect(goRow && within(goRow).getByText(/deepseek-v4\.1-flash/)).toBeTruthy();
  });
});

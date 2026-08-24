import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiConfig } from '@/types';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

// 共享的 react-i18next mock 在每次渲染时都会返回一个新的 t 函数，
// 而 ShadApiEditModal 的 fallbackAdapterOptions useMemo 依赖 [t]，
// 配合 setModelAdapterOptions 的同步 effect 会形成无限渲染循环。
// 这里给本文件换成 t/i18n 身份稳定的版本（与真实 react-i18next 的
// useTranslation 语义一致），文案仍走 zh-CN bundle。
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  const stableTranslation = { t: (actual as any).t, i18n: (actual as any).i18n };
  return {
    ...actual,
    useTranslation: () => stableTranslation,
  };
});

let ShadApiEditModal: typeof import('../ShadApiEditModal').ShadApiEditModal;

beforeAll(async () => {
  (window as any).__TAURI_INTERNALS__ = {};
  ({ ShadApiEditModal } = await import('../ShadApiEditModal'));
});

beforeEach(() => {
  invokeMock.mockReset();
});

const api = (authMode: string): ApiConfig => ({
  id: `model-${authMode}`,
  name: 'GPT Codex',
  providerType: 'openai_codex',
  authMode,
  apiProtocol: 'openai_responses',
  supportsOpenAIResponses: true,
  apiKey: '',
  baseUrl: 'https://chatgpt.com/backend-api/codex/responses',
  model: 'gpt-5.4',
  isMultimodal: true,
  isReasoning: true,
  isEmbedding: false,
  isReranker: false,
  enabled: true,
  modelAdapter: 'openai',
  supportsTools: true,
});

const renderEditor = (authMode: string) =>
  render(
    <ShadApiEditModal
      api={api(authMode)}
      onSave={vi.fn()}
      onCancel={vi.fn()}
      hideConnectionFields
      embeddedMode
    />
  );

describe('ShadApiEditModal Codex OAuth connection test', () => {
  it('opens the protocol menu above the editor surface', async () => {
    renderEditor('api_key');

    // AppSelect 触发器的 aria-label 是 t('app_menu.select_app')；
    // zh-CN common bundle 未收录该 key，可访问名回退为 key 本身。
    fireEvent.click(screen.getByRole('button', { name: 'app_menu.select_app' }));

    await waitFor(() => {
      const menu = screen.getByRole('menu');
      expect(menu).toBeInTheDocument();
      expect(Number(menu.style.zIndex)).toBeGreaterThan(1000);
    });
  });

  it('tests Codex OAuth without requiring an API key', async () => {
    invokeMock.mockResolvedValueOnce(true);
    renderEditor('openai_codex_oauth');

    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      'test_api_connection',
      expect.objectContaining({
        api_key: '',
        provider_type: 'openai_codex',
        auth_mode: 'openai_codex_oauth',
      }),
    ));
  });

  it('keeps the generic connection test available for API-key models', () => {
    renderEditor('api_key');

    expect(screen.getByRole('button', { name: '测试连接' })).toBeInTheDocument();
  });
});

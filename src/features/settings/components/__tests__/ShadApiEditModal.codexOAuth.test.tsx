import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiConfig } from '@/types';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

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

    fireEvent.click(screen.getByRole('button', { name: '选择选项' }));

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

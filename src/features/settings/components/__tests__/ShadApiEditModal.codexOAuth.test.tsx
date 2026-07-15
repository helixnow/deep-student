import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ApiConfig } from '@/types';
import { ShadApiEditModal } from '../ShadApiEditModal';

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
  it('hides the generic API-key connection test for Codex OAuth models', () => {
    renderEditor('openai_codex_oauth');

    expect(screen.queryByRole('button', { name: '测试连接' })).not.toBeInTheDocument();
  });

  it('keeps the generic connection test available for API-key models', () => {
    renderEditor('api_key');

    expect(screen.getByRole('button', { name: '测试连接' })).toBeInTheDocument();
  });
});

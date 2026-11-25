import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTranslation } from 'react-i18next';
import { WelcomeOnboardingDialog } from '../WelcomeOnboardingDialog';
import { QuickByokProvisionerCard } from '../byok/QuickByokProvisionerCard';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));

const JARGON_PATTERN = /\b(?:VFS|Slot|Slots|MCP|Tombstone|FTS|RAG|Auto-Provisioner|HTTP\s*\d{3})\b|能力槽位|向量索引/i;

describe('U01 zero-hint learner-friendly onboarding copy (zh-CN & en-US)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    const { i18n } = useTranslation();
    (i18n as { language: string }).language = 'zh-CN';
  });

  it('renders clear 3-step learning journey in zh-CN with zero leaky engineering jargon or emojis', () => {
    render(
      <WelcomeOnboardingDialog
        onConfigure={vi.fn()}
        onSkip={vi.fn()}
        preconfiguredAi={false}
      />,
    );

    const dialog = screen.getByRole('dialog');
    const text = dialog.textContent ?? '';

    expect(screen.getByTestId('welcome-feature-card-hub').textContent).toContain('导入学习资料');
    expect(screen.getByTestId('welcome-feature-card-chat').textContent).toContain('向 AI 提问与记笔记');
    expect(screen.getByTestId('welcome-feature-card-anki').textContent).toContain('制作闪卡与复习');
    expect(text).not.toMatch(JARGON_PATTERN);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('renders clear 3-step learning journey in en-US with zero leaky engineering jargon or emojis', () => {
    const { i18n } = useTranslation();
    (i18n as { language: string }).language = 'en-US';

    render(
      <WelcomeOnboardingDialog
        onConfigure={vi.fn()}
        onSkip={vi.fn()}
        preconfiguredAi={false}
      />,
    );

    const dialog = screen.getByRole('dialog');
    const text = dialog.textContent ?? '';

    expect(screen.getByTestId('welcome-feature-card-hub').textContent).toContain('Import your study materials');
    expect(screen.getByTestId('welcome-feature-card-chat').textContent).toContain('Ask AI & take notes');
    expect(screen.getByTestId('welcome-feature-card-anki').textContent).toContain('Make flashcards & review');
    expect(text).not.toMatch(JARGON_PATTERN);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('shows learner-friendly authentication error without raw HTTP status codes', async () => {
    const unauthorizedFetcher = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    render(
      <QuickByokProvisionerCard
        mode="onboarding"
        fetcher={unauthorizedFetcher}
      />,
    );

    fireEvent.change(screen.getByTestId('byok-key-input'), {
      target: { value: 'sk-proj-invalid1234567890abcdefghijklmnop' },
    });
    fireEvent.click(screen.getByTestId('byok-submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('byok-error-alert')).toBeInTheDocument();
    });
    const errText = screen.getByTestId('byok-error-alert').textContent ?? '';
    expect(errText).toContain('密钥验证未通过');
    expect(errText).not.toMatch(JARGON_PATTERN);
  });
});

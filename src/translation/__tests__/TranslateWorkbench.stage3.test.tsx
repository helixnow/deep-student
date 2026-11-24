import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { TranslationSession } from '@/dstu/adapters/translationDstuAdapter';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  translate: vi.fn(),
  registerContentDirtyChecker: vi.fn(() => () => {}),
  registerContentSaveHandler: vi.fn(() => () => {}),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/translation/useTranslationStream', () => ({
  TRANSLATION_STREAM_UNMOUNTED_ERROR: 'unmounted',
  useTranslationStream: () => {
    const [translatedText, setTranslatedText] = React.useState('');
    return {
      isTranslating: false,
      translatedText,
      translationId: null,
      error: null,
      detectedLang: null,
      isOffline: false,
      translationQuality: null,
      progress: 0,
      tokensPerSecond: null,
      startTime: null,
      partialResultInterrupted: false,
      startTranslation: mocks.translate,
      cancelTranslation: vi.fn(),
      resetState: vi.fn(),
      setTranslatedText,
      acknowledgePartialResult: vi.fn(),
    };
  },
}));
vi.mock('@/features/workbench/apps/content/contentDirtyRegistry', () => ({
  registerContentDirtyChecker: mocks.registerContentDirtyChecker,
  registerContentSaveHandler: mocks.registerContentSaveHandler,
}));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      typeof opts?.defaultValue === 'string' ? opts.defaultValue : key,
    i18n: { language: 'zh-CN' },
  }),
}));
vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
}));
vi.mock('@/components/shared/CommonTooltip', () => ({
  CommonTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/shared/Resizable', () => ({
  HorizontalResizable: ({ left, right }: { left: React.ReactNode; right: React.ReactNode }) => (
    <div>
      {left}
      {right}
    </div>
  ),
  VerticalResizable: ({ top, bottom }: { top: React.ReactNode; bottom: React.ReactNode }) => (
    <div>
      {top}
      {bottom}
    </div>
  ),
}));
vi.mock('@/translation/TranslationStreamRenderer', () => ({
  TranslationStreamRenderer: ({ content, placeholder }: { content: string; placeholder: string }) => (
    <div data-testid="translation-output">{content || placeholder}</div>
  ),
}));

import TranslateWorkbench from '@/components/TranslateWorkbench';

function makeSession(overrides: Partial<TranslationSession> = {}): TranslationSession {
  return {
    id: 'tr-1',
    title: 'Test Translation',
    sourceText: 'Hello world',
    translatedText: '你好，世界',
    srcLang: 'en',
    tgtLang: 'zh-CN',
    formality: 'auto',
    domain: 'general',
    glossary: [],
    createdAt: '2026-11-24T00:00:00Z',
    updatedAt: '2026-11-24T00:00:00Z',
    ...overrides,
  };
}

describe('TranslateWorkbench S3-11 fixes', () => {
  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
    mocks.invoke.mockReset();
    mocks.translate.mockReset();
  });

  it('renders independent Source and Target language selectors and allows direct Target selection', () => {
    const onSessionSave = vi.fn();
    render(
      <TranslateWorkbench
        dstuMode={{
          resourceId: 'tr-1',
          session: makeSession({ srcLang: 'en', tgtLang: 'zh-CN' }),
          onSessionSave,
        }}
      />,
    );

    const srcTrigger = screen.getByTestId('translation-source-lang-select');
    const tgtTrigger = screen.getByTestId('translation-target-lang-select');

    expect(srcTrigger).toHaveAttribute('aria-label', 'translation:languages.source_lang');
    expect(tgtTrigger).toHaveAttribute('aria-label', 'translation:languages.target_lang');

    // Open target selector independently and pick Japanese ('ja') in one click
    fireEvent.click(tgtTrigger);
    const japaneseOption = screen.getByText('translation:languages.ja');
    fireEvent.click(japaneseOption);

    expect(onSessionSave).toHaveBeenCalledWith(
      expect.objectContaining({
        srcLang: 'en',
        tgtLang: 'ja',
      }),
    );
  });

  it('keeps sourceText when swapping languages with empty translatedText and persists updated languages', () => {
    const onSessionSave = vi.fn();
    render(
      <TranslateWorkbench
        dstuMode={{
          resourceId: 'tr-2',
          session: makeSession({
            id: 'tr-2',
            srcLang: 'en',
            tgtLang: 'zh-CN',
            sourceText: 'Untranslated English text',
            translatedText: '',
          }),
          onSessionSave,
        }}
      />,
    );

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Untranslated English text');

    const swapButton = screen.getByRole('button', { name: 'translation:actions.swap_languages' });
    fireEvent.click(swapButton);

    // Original source text must NOT be erased when translatedText is empty
    expect(textarea.value).toBe('Untranslated English text');
    expect(screen.getByTestId('translation-swap-undo-banner')).toHaveTextContent(
      'translation:workbench_ui.swapped_lang_only_hint',
    );
    expect(onSessionSave).toHaveBeenCalledWith(
      expect.objectContaining({
        srcLang: 'zh-CN',
        tgtLang: 'en',
        sourceText: 'Untranslated English text',
      }),
    );
  });

  it('offers one-click undo snapshot after swapping non-empty source and translated texts', () => {
    const onSessionSave = vi.fn();
    render(
      <TranslateWorkbench
        dstuMode={{
          resourceId: 'tr-3',
          session: makeSession({
            id: 'tr-3',
            srcLang: 'en',
            tgtLang: 'zh-CN',
            sourceText: 'Original source',
            translatedText: '已翻译文本',
          }),
          onSessionSave,
        }}
      />,
    );

    const swapButton = screen.getByRole('button', { name: 'translation:actions.swap_languages' });
    fireEvent.click(swapButton);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe('已翻译文本');

    const banner = screen.getByTestId('translation-swap-undo-banner');
    expect(banner).toHaveTextContent('translation:workbench_ui.swapped_undo_hint');

    fireEvent.click(screen.getByTestId('translation-swap-undo-button'));

    expect(textarea.value).toBe('Original source');
    expect(screen.queryByTestId('translation-swap-undo-banner')).toBeNull();
    expect(onSessionSave).toHaveBeenLastCalledWith(
      expect.objectContaining({
        srcLang: 'en',
        tgtLang: 'zh-CN',
        sourceText: 'Original source',
        translatedText: '已翻译文本',
      }),
    );
  });

  it('restores srcLang and tgtLang when updated session arrives from backend hydration', () => {
    const onSessionSave = vi.fn();
    const { rerender } = render(
      <TranslateWorkbench
        dstuMode={{
          resourceId: 'tr-4',
          session: makeSession({
            id: 'tr-4',
            srcLang: 'en',
            tgtLang: 'zh-CN',
            sourceText: 'Bonjour',
            translatedText: '',
            updatedAt: '2026-11-24T00:00:00Z',
          }),
          onSessionSave,
        }}
      />,
    );

    rerender(
      <TranslateWorkbench
        dstuMode={{
          resourceId: 'tr-4',
          session: makeSession({
            id: 'tr-4',
            srcLang: 'fr',
            tgtLang: 'ja',
            sourceText: 'Bonjour',
            translatedText: 'こんにちは',
            updatedAt: '2026-11-24T00:05:00Z',
          }),
          onSessionSave,
        }}
      />,
    );

    expect(screen.getByTestId('translation-source-lang-select')).toHaveTextContent('translation:languages.fr');
    expect(screen.getByTestId('translation-target-lang-select')).toHaveTextContent('translation:languages.ja');
  });
});

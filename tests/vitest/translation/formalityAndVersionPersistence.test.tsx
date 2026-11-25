/**
 * S3-11 Round 5 P1 regression tests:
 * 1. Clicking "正式" (formal) radio switches state to 'formal', reflects aria-checked="true" /
 *    data-selected="true", resists stale async hydration back to 'auto', and sends formality='formal'
 *    in translation requests.
 * 2. Previous translation versions persist across reload (unmount/remount), keeping the
 *    "恢复上一版" banner & button visible and restoring v1 cleanly (plus bounded multi-version stack).
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
      isPartialResult: false,
      charCount: translatedText.length,
      wordCount: 0,
      sessionId: null,
      currentTranslationId: null,
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
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'translation:prompt_editor.formality': '语气',
        'translation:prompt_editor.formality_auto': '自动',
        'translation:prompt_editor.formality_formal': '正式',
        'translation:prompt_editor.formality_casual': '非正式',
        'translation:actions.translate': '翻译',
        'translation:actions.clear': '清空',
        'translation:workbench_ui.retranslated_undo_hint': '已生成新译文，可随时恢复上一版译文',
        'translation:workbench_ui.restore_previous': '恢复上一版',
        'translation:workbench_ui.restored_previous': '已恢复上一版译文',
        'translation:workbench_ui.dismiss': '知道了',
        'translation:workbench_ui.version_history_count': `共 ${opts?.count ?? 0} 个历史版本`,
      };
      if (key in map) return map[key]!;
      return typeof opts?.defaultValue === 'string' ? opts.defaultValue : key;
    },
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

import TranslateWorkbench, {
  normalizeTranslationFormality,
  pushTranslationVersion,
  readPersistedWorkbenchState,
} from '@/components/TranslateWorkbench';

function makeSession(overrides: Partial<TranslationSession> = {}): TranslationSession {
  const now = Date.now();
  return {
    id: 'tr-s3-11',
    sourceText: 'The gradient descent algorithm converges under Lipschitz continuity.',
    translatedText: '',
    srcLang: 'en',
    tgtLang: 'zh-CN',
    formality: 'auto',
    domain: 'general',
    glossary: [],
    createdAt: now - 10_000,
    updatedAt: now - 5_000,
    ...overrides,
  };
}

function getVisibleFormalityRadios() {
  const groups = screen.getAllByRole('radiogroup', { name: '语气' });
  const visibleGroup =
    groups.find((group) => !group.closest('[aria-hidden="true"]')) ?? groups[0]!;
  return {
    autoRadio: within(visibleGroup).getByRole('radio', { name: '自动' }),
    formalRadio: within(visibleGroup).getByRole('radio', { name: '正式' }),
    casualRadio: within(visibleGroup).getByRole('radio', { name: '非正式' }),
  };
}

describe('TranslateWorkbench S3-11 Round 5 P1 fixes', () => {
  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
    mocks.invoke.mockReset();
    mocks.translate.mockReset();
  });

  it('normalizes formality values and bounds version history to 5 entries', () => {
    expect(normalizeTranslationFormality('formal')).toBe('formal');
    expect(normalizeTranslationFormality('casual')).toBe('casual');
    expect(normalizeTranslationFormality('informal')).toBe('casual');
    expect(normalizeTranslationFormality('auto')).toBe('auto');
    expect(normalizeTranslationFormality('unknown')).toBeUndefined();

    let history: ReturnType<typeof pushTranslationVersion> = [];
    for (let i = 1; i <= 7; i += 1) {
      history = pushTranslationVersion(history, {
        id: `v${i}`,
        translatedText: `译文版本 ${i}`,
        sourceText: 'src',
        srcLang: 'en',
        tgtLang: 'zh-CN',
        formality: 'formal',
        domain: 'general',
        savedAt: 1000 + i,
      });
    }
    expect(history).toHaveLength(5);
    expect(history.map((item) => item.translatedText)).toEqual([
      '译文版本 7',
      '译文版本 6',
      '译文版本 5',
      '译文版本 4',
      '译文版本 3',
    ]);
  });

  it('switches to "正式" (formal), resists stale hydration reverting to "自动", and sends formality="formal" in requests', async () => {
    const onSessionSave = vi.fn().mockResolvedValue(undefined);
    mocks.translate.mockResolvedValue({
      outcome: 'completed',
      translatedText: '梯度下降算法在利普希茨连续条件下收敛。',
      translationId: 'tr-formal-1',
    });

    const initialSession = makeSession({
      id: 'tr-formal',
      formality: 'auto',
      translatedText: '梯度下降在 Lipschitz 连续条件下会收敛。',
    });

    const { rerender } = render(
      <TranslateWorkbench
        dstuMode={{
          resourceId: 'tr-formal',
          session: initialSession,
          onSessionSave,
        }}
      />,
    );

    let { autoRadio, formalRadio, casualRadio } = getVisibleFormalityRadios();
    expect(autoRadio).toHaveAttribute('aria-checked', 'true');
    expect(formalRadio).toHaveAttribute('aria-checked', 'false');
    expect(casualRadio).toHaveAttribute('aria-checked', 'false');

    // Click "正式" radio
    fireEvent.click(formalRadio);

    ({ autoRadio, formalRadio, casualRadio } = getVisibleFormalityRadios());
    expect(formalRadio).toHaveAttribute('aria-checked', 'true');
    expect(formalRadio).toHaveAttribute('data-selected', 'true');
    expect(autoRadio).toHaveAttribute('aria-checked', 'false');
    expect(autoRadio).toHaveAttribute('data-selected', 'false');

    // Persists immediately via flushSessionPersist with formality='formal'
    expect(onSessionSave).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tr-formal',
        formality: 'formal',
      }),
    );

    // Simulate a stale background VFS hydration (e.g. from dstu.rename / setMetadata refresh)
    // carrying old formality='auto' or undefined metadata: must NOT snap "正式" back to "自动"
    rerender(
      <TranslateWorkbench
        dstuMode={{
          resourceId: 'tr-formal',
          session: {
            ...initialSession,
            formality: 'auto',
            updatedAt: Date.now() + 500,
          },
          onSessionSave,
        }}
      />,
    );

    ({ autoRadio, formalRadio } = getVisibleFormalityRadios());
    expect(formalRadio).toHaveAttribute('aria-checked', 'true');
    expect(formalRadio).toHaveAttribute('data-selected', 'true');
    expect(autoRadio).toHaveAttribute('aria-checked', 'false');

    // Trigger translation and confirm formality: 'formal' is sent to the stream API & saved
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /翻译/ })[0]!);
    });

    expect(mocks.translate).toHaveBeenCalledWith(
      expect.objectContaining({
        formality: 'formal',
      }),
    );
    expect(onSessionSave).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'tr-formal',
        formality: 'formal',
        translatedText: '梯度下降算法在利普希茨连续条件下收敛。',
      }),
    );

    // Switching to "非正式" and back to "正式" works cleanly in both directions
    fireEvent.click(getVisibleFormalityRadios().casualRadio);
    expect(getVisibleFormalityRadios().casualRadio).toHaveAttribute('aria-checked', 'true');
    expect(getVisibleFormalityRadios().formalRadio).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(getVisibleFormalityRadios().formalRadio);
    expect(getVisibleFormalityRadios().formalRadio).toHaveAttribute('aria-checked', 'true');
    expect(getVisibleFormalityRadios().casualRadio).toHaveAttribute('aria-checked', 'false');
  });

  it('persists previous translation versions across reload (unmount/remount) and restores v1 cleanly', async () => {
    const savedSessions: TranslationSession[] = [];
    const onSessionSave = vi.fn().mockImplementation(async (session: TranslationSession) => {
      savedSessions.push(session);
    });

    mocks.translate
      .mockResolvedValueOnce({
        outcome: 'completed',
        translatedText: '第一版译文：在利普希茨连续条件下，梯度下降法会收敛。',
        translationId: 'tr-v1',
      })
      .mockResolvedValueOnce({
        outcome: 'completed',
        translatedText: '第二版正式译文：在满足利普希茨连续性条件时，梯度下降算法必然收敛。',
        translationId: 'tr-v2',
      })
      .mockResolvedValueOnce({
        outcome: 'completed',
        translatedText: '第三版非正式译文：只要满足 Lipschitz 连续，梯度下降就能收敛啦。',
        translationId: 'tr-v3',
      });

    const baseSession = makeSession({
      id: 'tr-reload-versions',
      translatedText: '',
      formality: 'auto',
    });

    const { unmount } = render(
      <TranslateWorkbench
        dstuMode={{
          resourceId: 'tr-reload-versions',
          session: baseSession,
          onSessionSave,
        }}
      />,
    );

    // Translate v1 (auto)
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /翻译/ })[0]!);
    });
    expect(screen.getByTestId('translation-output')).toHaveTextContent(
      '第一版译文：在利普希茨连续条件下，梯度下降法会收敛。',
    );
    expect(screen.queryByTestId('translation-previous-version-banner')).toBeNull();

    // Switch to formal and translate v2
    fireEvent.click(getVisibleFormalityRadios().formalRadio);
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /翻译/ })[0]!);
    });
    expect(screen.getByTestId('translation-output')).toHaveTextContent(
      '第二版正式译文：在满足利普希茨连续性条件时，梯度下降算法必然收敛。',
    );
    expect(screen.getByTestId('translation-previous-version-banner')).toHaveTextContent(
      '已生成新译文，可随时恢复上一版译文',
    );

    // Switch to casual and translate v3 so we have 2 saved previous versions (v2, v1)
    fireEvent.click(getVisibleFormalityRadios().casualRadio);
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /翻译/ })[0]!);
    });
    expect(screen.getByTestId('translation-output')).toHaveTextContent(
      '第三版非正式译文：只要满足 Lipschitz 连续，梯度下降就能收敛啦。',
    );
    expect(screen.getByTestId('translation-version-history-count')).toHaveTextContent(
      '共 2 个历史版本',
    );

    const latestSaved = savedSessions[savedSessions.length - 1]!;
    expect(latestSaved.translatedText).toBe(
      '第三版非正式译文：只要满足 Lipschitz 连续，梯度下降就能收敛啦。',
    );

    // Simulate full browser reload: unmount and remount with only the latest VFS translation record
    unmount();

    const persistedBeforeRemount = readPersistedWorkbenchState(['tr-reload-versions']);
    expect(persistedBeforeRemount?.versionHistory).toHaveLength(2);
    expect(persistedBeforeRemount?.versionHistory[0]?.translatedText).toBe(
      '第二版正式译文：在满足利普希茨连续性条件时，梯度下降算法必然收敛。',
    );
    expect(persistedBeforeRemount?.versionHistory[1]?.translatedText).toBe(
      '第一版译文：在利普希茨连续条件下，梯度下降法会收敛。',
    );

    render(
      <TranslateWorkbench
        dstuMode={{
          resourceId: 'tr-reload-versions',
          session: {
            ...latestSaved,
            // Even if VFS reload omits formality on initial node metadata, persisted state restores it
            formality: undefined,
          },
          onSessionSave,
        }}
      />,
    );

    // After reload: latest translation is visible, banner & "恢复上一版" button are STILL present!
    expect(screen.getByTestId('translation-output')).toHaveTextContent(
      '第三版非正式译文：只要满足 Lipschitz 连续，梯度下降就能收敛啦。',
    );
    expect(getVisibleFormalityRadios().casualRadio).toHaveAttribute('aria-checked', 'true');
    const bannerAfterReload = screen.getByTestId('translation-previous-version-banner');
    expect(bannerAfterReload).toHaveTextContent('已生成新译文，可随时恢复上一版译文');
    expect(screen.getByTestId('translation-version-history-count')).toHaveTextContent(
      '共 2 个历史版本',
    );

    // Click "恢复上一版" -> restores v2 cleanly and persists it to VFS
    await act(async () => {
      fireEvent.click(screen.getByTestId('translation-restore-previous-banner-button'));
    });
    expect(screen.getByTestId('translation-output')).toHaveTextContent(
      '第二版正式译文：在满足利普希茨连续性条件时，梯度下降算法必然收敛。',
    );
    expect(onSessionSave).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'tr-reload-versions',
        translatedText: '第二版正式译文：在满足利普希茨连续性条件时，梯度下降算法必然收敛。',
      }),
    );

    // v1 is still available in the history stack; clicking "恢复上一版" again restores v1 cleanly!
    expect(screen.getByTestId('translation-previous-version-banner')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId('translation-restore-previous-banner-button'));
    });
    expect(screen.getByTestId('translation-output')).toHaveTextContent(
      '第一版译文：在利普希茨连续条件下，梯度下降法会收敛。',
    );
    expect(onSessionSave).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'tr-reload-versions',
        translatedText: '第一版译文：在利普希茨连续条件下，梯度下降法会收敛。',
      }),
    );
    expect(screen.queryByTestId('translation-previous-version-banner')).toBeNull();
  });
});

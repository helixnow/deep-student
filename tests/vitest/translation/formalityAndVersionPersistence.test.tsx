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
        'translation:workbench_ui.outdated_hint': '原文或设置已更新，当前译文可能已过期',
        'translation:workbench_ui.retranslate_now': '重新翻译',
        'translation:workbench_ui.save_as_new_version': '另存新版本',
        'translation:workbench_ui.keep_current_translation': '保留当前译文',
        'translation:languages.zh-CN': '简体中文',
        'translation:languages.en': '英语',
        'translation:languages.ja': '日语',
        'translation:languages.fr': '法语',
        'translation:languages.target_lang': '目标语言',
        'translation:languages.source_lang': '源语言',
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
import {
  computeTranslationSourceHash,
  readTranslationDraftSnapshot,
} from '@/translation/sessionPrefs';

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
        formality: 'auto',
      }),
    );
    expect(screen.queryByTestId('translation-previous-version-banner')).toBeNull();
    expect(screen.queryByTestId('translation-outdated-banner')).toBeNull();
  });

  it('atomically restores targetLanguage, sourceLanguage, formality, and sourceHash across multi-language rollback and stays non-stale after reload (S3-11 Round 6)', async () => {
    const savedSessions: TranslationSession[] = [];
    const onSessionSave = vi.fn().mockImplementation(async (session: TranslationSession) => {
      savedSessions.push(session);
    });

    const sourceZh = '分布式系统的一致性协议需要在可用性与分区容错之间权衡。';
    const englishFormalDraft =
      'Consensus protocols in distributed systems must balance availability and partition tolerance.';
    const japaneseCasualDraft =
      '分散システムの合意プロトコルは可用性と分断耐性のバランスが大事だよ。';

    mocks.translate
      .mockResolvedValueOnce({
        outcome: 'completed',
        translatedText: englishFormalDraft,
        translationId: 'tr-en-v1',
      })
      .mockResolvedValueOnce({
        outcome: 'completed',
        translatedText: japaneseCasualDraft,
        translationId: 'tr-ja-v2',
      });

    const { unmount } = render(
      <TranslateWorkbench
        dstuMode={{
          resourceId: 'tr-multilang-rollback',
          session: makeSession({
            id: 'tr-multilang-rollback',
            sourceText: sourceZh,
            translatedText: '',
            srcLang: 'zh-CN',
            tgtLang: 'en',
            formality: 'formal',
          }),
          onSessionSave,
        }}
      />,
    );

    // Step 1: Translate Chinese -> English (formal)
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /翻译/ })[0]!);
    });
    expect(screen.getByTestId('translation-output')).toHaveTextContent(englishFormalDraft);
    expect(screen.getByTestId('translation-target-lang-select')).toHaveTextContent('英语');
    expect(getVisibleFormalityRadios().formalRadio).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('translation-outdated-banner')).toBeNull();

    // Step 2: Switch target language to Japanese and formality to casual -> outdated banner appears with non-destructive options
    fireEvent.click(screen.getByTestId('translation-target-lang-select'));
    fireEvent.click(screen.getByText('日语'));
    fireEvent.click(getVisibleFormalityRadios().casualRadio);

    expect(screen.getByTestId('translation-outdated-banner')).toBeInTheDocument();
    expect(screen.getByTestId('translation-outdated-save-new-version-btn')).toHaveTextContent('另存新版本');
    expect(screen.getByTestId('translation-outdated-retranslate-btn')).toHaveTextContent('重新翻译');
    expect(screen.getByTestId('translation-outdated-keep-current-btn')).toHaveTextContent('保留当前译文');

    // Step 3: Translate Chinese -> Japanese (casual)
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /翻译/ })[0]!);
    });
    expect(screen.getByTestId('translation-output')).toHaveTextContent(japaneseCasualDraft);
    expect(screen.getByTestId('translation-target-lang-select')).toHaveTextContent('日语');
    expect(getVisibleFormalityRadios().casualRadio).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('translation-outdated-banner')).toBeNull();

    // Version history snapshot captures full English v1 metadata + sourceHash
    expect(screen.getByTestId('translation-previous-version-meta')).toHaveTextContent('英语 · 正式');
    const persistedBeforeRestore = readPersistedWorkbenchState(['tr-multilang-rollback']);
    expect(persistedBeforeRestore?.versionHistory[0]).toMatchObject({
      translatedText: englishFormalDraft,
      sourceText: sourceZh,
      sourceHash: computeTranslationSourceHash(sourceZh),
      srcLang: 'zh-CN',
      tgtLang: 'en',
      formality: 'formal',
    });

    // Step 4: Restore previous version -> MUST atomically roll back body + targetLanguage (en) + formality (formal)
    await act(async () => {
      fireEvent.click(screen.getByTestId('translation-restore-previous-banner-button'));
    });

    expect(screen.getByTestId('translation-output')).toHaveTextContent(englishFormalDraft);
    expect(screen.getByTestId('translation-target-lang-select')).toHaveTextContent('英语');
    expect(getVisibleFormalityRadios().formalRadio).toHaveAttribute('aria-checked', 'true');
    expect(getVisibleFormalityRadios().casualRadio).toHaveAttribute('aria-checked', 'false');
    // Immediately after rollback, English draft matching restored en/formal/source is NOT stale!
    expect(screen.queryByTestId('translation-outdated-banner')).toBeNull();

    const restoredSave = savedSessions[savedSessions.length - 1]!;
    expect(restoredSave).toMatchObject({
      id: 'tr-multilang-rollback',
      translatedText: englishFormalDraft,
      srcLang: 'zh-CN',
      tgtLang: 'en',
      formality: 'formal',
      lastTranslatedMeta: expect.objectContaining({
        sourceText: sourceZh,
        sourceHash: computeTranslationSourceHash(sourceZh),
        srcLang: 'zh-CN',
        tgtLang: 'en',
        formality: 'formal',
      }),
    });

    // Local draft snapshot also carries restored tgtLang + formality + lastTranslatedMeta
    expect(readTranslationDraftSnapshot('tr-multilang-rollback')).toMatchObject({
      srcLang: 'zh-CN',
      tgtLang: 'en',
      formality: 'formal',
      translatedText: englishFormalDraft,
      lastTranslatedMeta: expect.objectContaining({
        tgtLang: 'en',
        formality: 'formal',
        sourceHash: computeTranslationSourceHash(sourceZh),
      }),
    });

    // Step 5: Simulate full page reload (including stale VFS list metadata carrying old tgtLang='ja' / undefined formality,
    // followed by async v2 hydration!)
    unmount();

    const { rerender } = render(
      <TranslateWorkbench
        dstuMode={{
          resourceId: 'tr-multilang-rollback',
          session: {
            ...restoredSave,
            // Stale VFS table columns on first frame before v2 content loads
            tgtLang: 'ja',
            formality: undefined,
            lastTranslatedMeta: undefined,
            updatedAt: restoredSave.updatedAt - 1000,
          },
          onSessionSave,
        }}
      />,
    );

    // Even on first frame with stale SQL metadata, persisted rollback snapshot keeps en + formal + non-stale!
    expect(screen.getByTestId('translation-output')).toHaveTextContent(englishFormalDraft);
    expect(screen.getByTestId('translation-target-lang-select')).toHaveTextContent('英语');
    expect(getVisibleFormalityRadios().formalRadio).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('translation-outdated-banner')).toBeNull();

    // Async VFS v2 hydration arrives with authoritative restored session
    rerender(
      <TranslateWorkbench
        dstuMode={{
          resourceId: 'tr-multilang-rollback',
          session: restoredSave,
          onSessionSave,
        }}
      />,
    );

    expect(screen.getByTestId('translation-output')).toHaveTextContent(englishFormalDraft);
    expect(screen.getByTestId('translation-target-lang-select')).toHaveTextContent('英语');
    expect(getVisibleFormalityRadios().formalRadio).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('translation-outdated-banner')).toBeNull();
  });

  it('handles genuine source edits after reload with non-destructive Keep Current and Save as New Version choices', async () => {
    const savedSessions: TranslationSession[] = [];
    const onSessionSave = vi.fn().mockImplementation(async (session: TranslationSession) => {
      savedSessions.push(session);
    });

    const sourceV1 = 'The theorem holds for all compact metric spaces.';
    const sourceV2 = 'The theorem holds for all compact metric spaces and separable Banach spaces.';
    const sourceV3 = 'The theorem holds for all complete metric spaces.';
    const transV1 = '该定理对所有紧致度量空间成立。';
    const transV2 = '该定理对所有完备度量空间成立。';

    mocks.translate
      .mockResolvedValueOnce({
        outcome: 'completed',
        translatedText: transV1,
        translationId: 'tr-src-v1',
      })
      .mockResolvedValueOnce({
        outcome: 'completed',
        translatedText: transV2,
        translationId: 'tr-src-v2',
      });

    const { unmount } = render(
      <TranslateWorkbench
        dstuMode={{
          resourceId: 'tr-nondestructive',
          session: makeSession({
            id: 'tr-nondestructive',
            sourceText: sourceV1,
            translatedText: '',
            srcLang: 'en',
            tgtLang: 'zh-CN',
            formality: 'formal',
          }),
          onSessionSave,
        }}
      />,
    );

    // Produce initial completed translation
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /翻译/ })[0]!);
    });
    expect(screen.getByTestId('translation-output')).toHaveTextContent(transV1);
    expect(screen.queryByTestId('translation-outdated-banner')).toBeNull();

    // Edit source text -> translation is genuinely out of sync with edited source
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: sourceV2 } });
    expect(screen.getByTestId('translation-outdated-banner')).toBeInTheDocument();

    // Simulate reload with edited source + persisted syncedMeta still pointing to sourceV1 hash
    const latestPersistedSession = savedSessions[savedSessions.length - 1]!;
    unmount();

    render(
      <TranslateWorkbench
        dstuMode={{
          resourceId: 'tr-nondestructive',
          session: {
            ...latestPersistedSession,
            sourceText: sourceV2,
            translatedText: transV1,
          },
          onSessionSave,
        }}
      />,
    );

    // After reload, genuinely out-of-sync source is detected AND offers non-destructive actions
    expect(screen.getByTestId('translation-outdated-banner')).toBeInTheDocument();

    // Choice 1: "保留当前译文" dismisses warning without overwriting or calling translate
    fireEvent.click(screen.getByTestId('translation-outdated-keep-current-btn'));
    expect(screen.queryByTestId('translation-outdated-banner')).toBeNull();
    expect(screen.getByTestId('translation-output')).toHaveTextContent(transV1);
    expect(mocks.translate).toHaveBeenCalledTimes(1);

    // Further source edit brings back the banner for the new delta
    const reloadedTextarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(reloadedTextarea, { target: { value: sourceV3 } });
    expect(screen.getByTestId('translation-outdated-banner')).toBeInTheDocument();

    // Choice 2: "另存新版本" preserves transV1 into version history and translates sourceV3 cleanly
    await act(async () => {
      fireEvent.click(screen.getByTestId('translation-outdated-save-new-version-btn'));
    });

    expect(screen.getByTestId('translation-output')).toHaveTextContent(transV2);
    expect(screen.queryByTestId('translation-outdated-banner')).toBeNull();
    // Archived v1 is preserved in version history with original sourceHash & formality
    const persistedAfterNewVer = readPersistedWorkbenchState(['tr-nondestructive']);
    expect(persistedAfterNewVer?.versionHistory[0]).toMatchObject({
      translatedText: transV1,
      sourceText: sourceV1,
      sourceHash: computeTranslationSourceHash(sourceV1),
      srcLang: 'en',
      tgtLang: 'zh-CN',
      formality: 'formal',
    });
    expect(screen.getByTestId('translation-previous-version-banner')).toBeInTheDocument();
  });

  it('preserves 3-language + formality stack across multiple reloads and sequential rollbacks with zero false staleness even after async prompt load', async () => {
    const savedSessions: TranslationSession[] = [];
    const onSessionSave = vi.fn().mockImplementation(async (session: TranslationSession) => {
      savedSessions.push(session);
    });
    // Simulate async TauriAPI.getSetting('translation.prompt') returning default prompt on reload
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_setting') return 'translation:prompt_editor.default_prompt';
      return null;
    });

    const src = '量子纠缠在量子通信中具有核心作用。';
    const enFormal = 'Quantum entanglement plays a central role in quantum communication.';
    const jaCasual = '量子もつれは量子通信で大事な役割を果たすよ。';
    const frAuto = "L'intrication quantique joue un rôle central dans la communication quantique.";

    mocks.translate
      .mockResolvedValueOnce({ outcome: 'completed', translatedText: enFormal, translationId: 'v1' })
      .mockResolvedValueOnce({ outcome: 'completed', translatedText: jaCasual, translationId: 'v2' })
      .mockResolvedValueOnce({ outcome: 'completed', translatedText: frAuto, translationId: 'v3' });

    const { unmount } = render(
      <TranslateWorkbench
        dstuMode={{
          resourceId: 'tr-3lang',
          session: makeSession({
            id: 'tr-3lang',
            sourceText: src,
            translatedText: '',
            srcLang: 'zh-CN',
            tgtLang: 'en',
            formality: 'formal',
          }),
          onSessionSave,
        }}
      />,
    );

    // v1: en + formal
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /翻译/ })[0]!);
    });
    // v2: ja + casual
    fireEvent.click(screen.getByTestId('translation-target-lang-select'));
    fireEvent.click(screen.getByText('日语'));
    fireEvent.click(getVisibleFormalityRadios().casualRadio);
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /翻译/ })[0]!);
    });
    // v3: fr + auto
    fireEvent.click(screen.getByTestId('translation-target-lang-select'));
    fireEvent.click(screen.getByText('法语'));
    fireEvent.click(getVisibleFormalityRadios().autoRadio);
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /翻译/ })[0]!);
    });

    expect(screen.getByTestId('translation-output')).toHaveTextContent(frAuto);
    expect(screen.getByTestId('translation-version-history-count')).toHaveTextContent('共 2 个历史版本');

    // Reload #1 while at v3 (fr / auto)
    const savedAtV3 = savedSessions[savedSessions.length - 1]!;
    unmount();

    const mount2 = render(
      <TranslateWorkbench
        dstuMode={{ resourceId: 'tr-3lang', session: savedAtV3, onSessionSave }}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('translation-output')).toHaveTextContent(frAuto);
    expect(screen.getByTestId('translation-target-lang-select')).toHaveTextContent('法语');
    expect(getVisibleFormalityRadios().autoRadio).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('translation-outdated-banner')).toBeNull();
    expect(screen.getByTestId('translation-previous-version-meta')).toHaveTextContent('日语 · 非正式');

    // Rollback #1 -> v2 (ja / casual)
    await act(async () => {
      fireEvent.click(screen.getByTestId('translation-restore-previous-banner-button'));
    });
    expect(screen.getByTestId('translation-output')).toHaveTextContent(jaCasual);
    expect(screen.getByTestId('translation-target-lang-select')).toHaveTextContent('日语');
    expect(getVisibleFormalityRadios().casualRadio).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('translation-outdated-banner')).toBeNull();
    expect(screen.getByTestId('translation-previous-version-meta')).toHaveTextContent('英语 · 正式');

    // Reload #2 while at restored v2 (ja / casual)
    const savedAtV2 = savedSessions[savedSessions.length - 1]!;
    mount2.unmount();

    const mount3 = render(
      <TranslateWorkbench
        dstuMode={{ resourceId: 'tr-3lang', session: savedAtV2, onSessionSave }}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('translation-output')).toHaveTextContent(jaCasual);
    expect(screen.getByTestId('translation-target-lang-select')).toHaveTextContent('日语');
    expect(getVisibleFormalityRadios().casualRadio).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('translation-outdated-banner')).toBeNull();

    // Rollback #2 -> v1 (en / formal)
    await act(async () => {
      fireEvent.click(screen.getByTestId('translation-restore-previous-banner-button'));
    });
    expect(screen.getByTestId('translation-output')).toHaveTextContent(enFormal);
    expect(screen.getByTestId('translation-target-lang-select')).toHaveTextContent('英语');
    expect(getVisibleFormalityRadios().formalRadio).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('translation-outdated-banner')).toBeNull();
    expect(screen.queryByTestId('translation-previous-version-banner')).toBeNull();

    // Reload #3 while at restored v1 (en / formal)
    const savedAtV1 = savedSessions[savedSessions.length - 1]!;
    mount3.unmount();

    render(
      <TranslateWorkbench
        dstuMode={{ resourceId: 'tr-3lang', session: savedAtV1, onSessionSave }}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('translation-output')).toHaveTextContent(enFormal);
    expect(screen.getByTestId('translation-target-lang-select')).toHaveTextContent('英语');
    expect(getVisibleFormalityRadios().formalRadio).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('translation-outdated-banner')).toBeNull();
  });

  it('flags honest source-hash mismatch when restoring an older version after source edits, and clears staleness when source reverts', async () => {
    const onSessionSave = vi.fn().mockResolvedValue(undefined);
    const src1 = '第一版中文原文。';
    const src2 = '第二版已修改中文原文。';
    const en1 = 'First version Chinese source text.';
    const ja2 = '第二版の修正済み原文です。';

    mocks.translate
      .mockResolvedValueOnce({ outcome: 'completed', translatedText: en1, translationId: 's1' })
      .mockResolvedValueOnce({ outcome: 'completed', translatedText: ja2, translationId: 's2' });

    render(
      <TranslateWorkbench
        dstuMode={{
          resourceId: 'tr-src-hash-mismatch',
          session: makeSession({
            id: 'tr-src-hash-mismatch',
            sourceText: src1,
            translatedText: '',
            srcLang: 'zh-CN',
            tgtLang: 'en',
            formality: 'formal',
          }),
          onSessionSave,
        }}
      />,
    );

    // Translate src1 -> en1 (formal)
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /翻译/ })[0]!);
    });

    // Edit source to src2, switch to ja/casual, translate -> ja2
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: src2 } });
    fireEvent.click(screen.getByTestId('translation-target-lang-select'));
    fireEvent.click(screen.getByText('日语'));
    fireEvent.click(getVisibleFormalityRadios().casualRadio);
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /翻译/ })[0]!);
    });
    expect(screen.getByTestId('translation-output')).toHaveTextContent(ja2);

    // Restore v1: restores en1 + en + formal while keeping user's edited src2,
    // and honestly marks out-of-sync with non-destructive options
    await act(async () => {
      fireEvent.click(screen.getByTestId('translation-restore-previous-banner-button'));
    });
    expect(screen.getByTestId('translation-output')).toHaveTextContent(en1);
    expect(screen.getByTestId('translation-target-lang-select')).toHaveTextContent('英语');
    expect(getVisibleFormalityRadios().formalRadio).toHaveAttribute('aria-checked', 'true');
    expect(textarea.value).toBe(src2);
    expect(screen.getByTestId('translation-outdated-banner')).toBeInTheDocument();
    expect(screen.getByTestId('translation-outdated-save-new-version-btn')).toBeInTheDocument();
    expect(screen.getByTestId('translation-outdated-keep-current-btn')).toBeInTheDocument();

    // Reverting source text back to src1 matches restored v1's sourceHash -> no longer stale!
    fireEvent.change(textarea, { target: { value: src1 } });
    expect(screen.queryByTestId('translation-outdated-banner')).toBeNull();
  });
});

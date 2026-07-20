import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  translatedText: '',
  setTranslatedText: vi.fn((value: string) => {
    mocks.translatedText = value;
  }),
  getModels: vi.fn(async () => []),
  getModes: vi.fn(async () => []),
  getSession: vi.fn(async () => null),
  getRounds: vi.fn(async () => []),
}));

vi.mock('@/translation/useTranslationStream', () => ({
  useTranslationStream: () => ({
    translatedText: mocks.translatedText,
    isTranslating: false,
    setTranslatedText: mocks.setTranslatedText,
    error: null,
    startTranslation: vi.fn(async () => 'cancelled'),
    cancelTranslation: vi.fn(),
  }),
}));

vi.mock('@/essay-grading/useEssayGradingStream', () => ({
  useEssayGradingStream: () => ({
    gradingResult: '',
    isGrading: false,
    isPartialResult: false,
    error: null,
    canRetry: false,
    setGradingResult: vi.fn(),
    startGrading: vi.fn(async () => 'cancelled'),
    cancelGrading: vi.fn(),
    resetState: vi.fn(),
    retryGrading: vi.fn(async () => undefined),
  }),
}));

vi.mock('@/essay-grading/essayGradingApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/essay-grading/essayGradingApi')>();
  return {
    ...actual,
    EssayGradingAPI: {
      ...actual.EssayGradingAPI,
      getModels: mocks.getModels,
      getGradingModes: mocks.getModes,
      getSession: mocks.getSession,
      getRounds: mocks.getRounds,
    },
  };
});

vi.mock('@/utils/tauriApi', () => ({
  TauriAPI: {
    getSetting: vi.fn(async () => null),
    saveSetting: vi.fn(async () => undefined),
  },
  ocrExtractText: vi.fn(async () => ''),
}));

vi.mock('@/components/layout/MacTopSafeDragZone', () => ({
  MacTopSafeDragZone: () => null,
}));

vi.mock('@/components/ui/DsDialog', () => ({
  DsAlertDialog: () => null,
}));

vi.mock('@/hooks/useEventRegistry', () => ({
  useEventRegistry: () => undefined,
}));

vi.mock('@/components/translation/TranslationMain', () => ({
  TranslationMain: ({ sourceText, setSourceText }: {
    sourceText: string;
    setSourceText: (value: string) => void;
  }) => (
    <textarea
      aria-label="translation-source"
      value={sourceText}
      onChange={(event) => setSourceText(event.target.value)}
    />
  ),
}));

vi.mock('@/components/essay-grading/GradingMain', () => ({
  GradingMain: ({
    inputText,
    setInputText,
    topicText,
    setTopicText,
  }: {
    inputText: string;
    setInputText: (value: string) => void;
    topicText: string;
    setTopicText: (value: string) => void;
  }) => (
    <>
      <textarea
        aria-label="essay-input"
        value={inputText}
        onChange={(event) => setInputText(event.target.value)}
      />
      <textarea
        aria-label="essay-topic"
        value={topicText}
        onChange={(event) => setTopicText(event.target.value)}
      />
    </>
  ),
}));

import { TranslateWorkbench } from '@/components/TranslateWorkbench';
import { EssayGradingWorkbench } from '@/components/EssayGradingWorkbench';
import { NotesEditorHeader } from '@/features/notes/components/NotesEditorHeader';
import { createContentApp } from '../createContentApp';
import {
  __resetContentDirtyRegistry,
  isContentDirty,
  registerContentDirtyChecker,
} from '../contentDirtyRegistry';

function guardedDefinition(typeId: 'note' | 'translation' | 'essay') {
  return createContentApp({
    typeId,
    nameKey: `workbench:apps.${typeId}`,
    icon: null,
    memoryWeight: 2,
    defaultFrame: { w: 800, h: 600 },
    confirmUnsavedOnClose: true,
  });
}

describe('content dirty integration', () => {
  beforeEach(() => {
    __resetContentDirtyRegistry();
    mocks.translatedText = '';
    mocks.setTranslatedText.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    __resetContentDirtyRegistry();
  });

  it('Translation 输入原文后真实注册 dirty 并阻止关闭', async () => {
    render(
      <TranslateWorkbench
        dstuMode={{
          resourceId: 'translation_1',
          session: {
            id: 'translation_1',
            sourceText: '',
            translatedText: '',
            srcLang: 'auto',
            tgtLang: 'zh-CN',
            formality: 'auto',
            createdAt: 1,
            updatedAt: 1,
          },
        }}
      />,
    );

    await waitFor(() => expect(isContentDirty('translation', '/translation_1')).toBe(false));
    fireEvent.change(screen.getByLabelText('translation-source'), { target: { value: 'unsaved' } });
    expect(isContentDirty('translation', 'translation_1')).toBe(true);

    const nativeConfirm = vi.spyOn(window, 'confirm');
    await expect(guardedDefinition('translation').canClose?.('/folder/translation_1')).resolves.toBe(false);
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it('Essay 正文和题目元数据都参与真实 dirty 状态', async () => {
    render(
      <EssayGradingWorkbench
        dstuMode={{
          resourceId: 'essay_1',
          session: {
            id: 'essay_1',
            title: 'Essay',
            inputText: '',
            essayType: 'other',
            gradeLevel: 'high_school',
            modeId: 'practice',
            rounds: [],
            isFavorite: false,
            createdAt: 1,
            updatedAt: 1,
          },
        }}
      />,
    );

    await waitFor(() => expect(isContentDirty('essay', 'essay_1')).toBe(false));
    fireEvent.change(screen.getByLabelText('essay-topic'), { target: { value: 'Topic metadata' } });
    expect(isContentDirty('essay', '/folder/essay_1')).toBe(true);

    const nativeConfirm = vi.spyOn(window, 'confirm');
    await expect(guardedDefinition('essay').canClose?.('essay_1')).resolves.toBe(false);
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it('Note 标题 checker 与正文 checker 聚合', async () => {
    const unregisterBody = registerContentDirtyChecker('note', 'note_1', () => false);
    render(
      <NotesEditorHeader
        lastSaved={null}
        initialTitle="Saved title"
        noteId="note_1"
        onTitleChange={vi.fn(async () => undefined)}
      />,
    );

    const input = await screen.findByDisplayValue('Saved title');
    fireEvent.change(input, { target: { value: 'Unsaved title' } });
    expect(isContentDirty('note', '/folder/note_1')).toBe(true);

    const nativeConfirm = vi.spyOn(window, 'confirm');
    await expect(guardedDefinition('note').canClose?.('/note_1')).resolves.toBe(false);
    expect(nativeConfirm).not.toHaveBeenCalled();
    unregisterBody();
  });
});

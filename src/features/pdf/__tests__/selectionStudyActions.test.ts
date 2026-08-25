import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';

const mocks = vi.hoisted(() => ({
  dispatchAppEvent: vi.fn(),
  showGlobalNotification: vi.fn(),
  generateCardsFromSelection: vi.fn(async () => ({ ok: true as const })),
  getFixedT: vi.fn(() => ((key: string) => key) as unknown as TFunction),
}));

vi.mock('@/events', () => ({
  APP_EVENTS: { PREFILL_CHAT_INPUT: 'app:prefill-chat-input' },
  dispatchAppEvent: mocks.dispatchAppEvent,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: mocks.showGlobalNotification,
}));

vi.mock('@/features/chat/services/selectionCardGeneration', () => ({
  generateCardsFromSelection: mocks.generateCardsFromSelection,
}));

vi.mock('@/i18n', () => ({
  default: { getFixedT: mocks.getFixedT },
}));

import {
  MIN_SELECTION_LENGTH_FOR_QUESTIONS,
  buildQuestionGenerationPrompt,
  makeCardsFromSelection,
  sendSelectionToQuestionGeneration,
} from '../selectionStudyActions';

/** 假 t：返回 defaultValue 并做 {{var}} 插值（与 i18next 语义一致的最小子集） */
const fakeT = ((key: string, options?: Record<string, unknown>) => {
  const template = (options?.defaultValue as string) ?? key;
  return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(options?.[name] ?? ''));
}) as unknown as TFunction;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildQuestionGenerationPrompt', () => {
  it('embeds the source (name + page) and the trimmed material', () => {
    const prompt = buildQuestionGenerationPrompt(
      { text: '细胞膜具有选择透过性。', sourceName: '生物必修一.pdf', page: 42 },
      fakeT,
    );
    expect(prompt).toContain('《生物必修一.pdf》第 42 页');
    expect(prompt).toContain('【学习材料】');
    expect(prompt).toContain('细胞膜具有选择透过性。');
  });

  it('falls back to a generic source label when file name is unknown', () => {
    const prompt = buildQuestionGenerationPrompt({ text: '材料内容' }, fakeT);
    expect(prompt).toContain('阅读器划词摘录');
  });
});

describe('sendSelectionToQuestionGeneration', () => {
  it('prefills chat without auto-sending for valid selections', () => {
    const result = sendSelectionToQuestionGeneration(
      { text: '光合作用的光反应发生在类囊体薄膜上。', sourceName: '生物.pdf', page: 3 },
      fakeT,
    );
    expect(result.ok).toBe(true);
    expect(mocks.dispatchAppEvent).toHaveBeenCalledWith(
      'app:prefill-chat-input',
      expect.objectContaining({ autoSend: false, content: expect.stringContaining('光合作用') }),
    );
    expect(mocks.showGlobalNotification).not.toHaveBeenCalled();
  });

  it('rejects empty selections with a warning instead of dispatching', () => {
    const result = sendSelectionToQuestionGeneration({ text: '   ' }, fakeT);
    expect(result).toEqual({ ok: false, reason: 'empty' });
    expect(mocks.dispatchAppEvent).not.toHaveBeenCalled();
    expect(mocks.showGlobalNotification).toHaveBeenCalledWith('warning', expect.any(String));
  });

  it('rejects selections shorter than the shared threshold', () => {
    const result = sendSelectionToQuestionGeneration(
      { text: 'a'.repeat(MIN_SELECTION_LENGTH_FOR_QUESTIONS - 1) },
      fakeT,
    );
    expect(result).toEqual({ ok: false, reason: 'too_short' });
    expect(mocks.dispatchAppEvent).not.toHaveBeenCalled();
  });
});

describe('makeCardsFromSelection', () => {
  it('delegates to the chat selection card service with a chatV2-scoped t', async () => {
    await makeCardsFromSelection({
      text: '需要制卡的内容片段',
      contextBefore: '前文',
      contextAfter: '后文',
    });
    expect(mocks.getFixedT).toHaveBeenCalledWith(null, 'chatV2');
    expect(mocks.generateCardsFromSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedText: '需要制卡的内容片段',
        contextBefore: '前文',
        contextAfter: '后文',
        t: expect.any(Function),
      }),
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockStartGeneration,
  mockShowGlobalNotification,
  mockInvoke,
} = vi.hoisted(() => ({
  mockStartGeneration: vi.fn(),
  mockShowGlobalNotification: vi.fn(),
  mockInvoke: vi.fn(),
}));

vi.mock('@/components/anki/cardforge', () => ({
  cardAgent: {
    startGeneration: mockStartGeneration,
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: mockShowGlobalNotification,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}));

vi.mock('@/events', () => ({
  APP_EVENTS: {
    MOBILE_APP_NAVIGATE: 'deepstudent:mobile-sidebar-navigate',
  },
  dispatchAppEvent: vi.fn(),
}));

import {
  DEFAULT_SELECTION_MAX_CARDS,
  MIN_SELECTION_LENGTH_FOR_CARDS,
  buildSelectionCardContent,
  generateCardsFromSelection,
  validateSelectionForCards,
} from '../selectionCardGeneration';

describe('selectionCardGeneration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStartGeneration.mockResolvedValue({ ok: true, documentId: 'doc-1' });
    mockInvoke.mockResolvedValue(undefined);
  });

  describe('validateSelectionForCards', () => {
    it('rejects empty or whitespace-only text', () => {
      expect(validateSelectionForCards('')).toEqual({ ok: false, reason: 'empty' });
      expect(validateSelectionForCards('   \n\t')).toEqual({ ok: false, reason: 'empty' });
    });

    it(`rejects text shorter than ${MIN_SELECTION_LENGTH_FOR_CARDS} characters`, () => {
      expect(validateSelectionForCards('短文本')).toEqual({ ok: false, reason: 'too_short' });
      expect(validateSelectionForCards('123456789')).toEqual({ ok: false, reason: 'too_short' });
    });

    it('accepts trimmed text meeting the minimum length', () => {
      const text = '这是一段足够长的选中文本';
      expect(text.trim().length).toBeGreaterThanOrEqual(MIN_SELECTION_LENGTH_FOR_CARDS);
      expect(validateSelectionForCards(`  ${text}  `)).toEqual({ ok: true, text });
    });
  });

  describe('buildSelectionCardContent', () => {
    it('returns selected text when no context is provided', () => {
      expect(buildSelectionCardContent('核心内容')).toBe('核心内容');
    });

    it('wraps optional surrounding context for the generator', () => {
      const content = buildSelectionCardContent('核心内容', {
        contextBefore: '前文',
        contextAfter: '后文',
      });
      expect(content).toContain('核心内容');
      expect(content).toContain('前文');
      expect(content).toContain('后文');
    });
  });

  describe('generateCardsFromSelection', () => {
    const t = ((key: string, fallback?: string) => fallback ?? key) as typeof import('i18next').t;

    it('toasts and returns early when selection is too short', async () => {
      const result = await generateCardsFromSelection({
        selectedText: '太短了',
        t,
      });

      expect(result).toEqual({ ok: false, reason: 'too_short' });
      expect(mockStartGeneration).not.toHaveBeenCalled();
      expect(mockShowGlobalNotification).toHaveBeenCalledWith('warning', expect.any(String));
    });

    it('starts the backend pipeline (fire-and-forget) with short-text quota and links session', async () => {
      const selectedText = '这是一段足够长的选中文本用于制卡';
      const result = await generateCardsFromSelection({
        selectedText,
        sessionId: 'sess_abc',
        contextBefore: '前文上下文',
        contextAfter: '后文上下文',
        t,
      });

      // 生产路径：cardAgent.startGeneration → start_enhanced_document_processing
      // （非阻塞启动，进度由任务台跟踪），不再经 ChatV2AnkiAdapter 阻塞收集
      expect(mockStartGeneration).toHaveBeenCalledTimes(1);
      const [input] = mockStartGeneration.mock.calls[0];
      expect(input.content).toContain(selectedText);
      expect(input.content).toContain('前文上下文');
      expect(input.content).toContain('后文上下文');
      expect(input.maxCards).toBe(DEFAULT_SELECTION_MAX_CARDS);
      expect(input.options).toMatchObject({
        deckName: expect.any(String),
        customRequirements: expect.any(String),
      });

      expect(result).toEqual({ ok: true, documentId: 'doc-1' });
      expect(mockInvoke).toHaveBeenCalledWith('set_document_session_source', {
        documentId: 'doc-1',
        sessionId: 'sess_abc',
      });
      expect(mockShowGlobalNotification).toHaveBeenCalledWith(
        'success',
        expect.any(String),
        undefined,
        expect.objectContaining({
          action: expect.objectContaining({ label: expect.any(String) }),
        })
      );
    });

    it('toasts failure when the pipeline start returns ok:false', async () => {
      mockStartGeneration.mockResolvedValue({ ok: false, error: 'boom' });

      const result = await generateCardsFromSelection({
        selectedText: '这是一段足够长的选中文本用于制卡',
        t,
      });

      expect(result).toEqual({ ok: false, reason: 'generate_failed', error: 'boom' });
      expect(mockShowGlobalNotification).toHaveBeenCalledWith(
        'error',
        expect.stringContaining('boom')
      );
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('toasts failure when startGeneration throws', async () => {
      mockStartGeneration.mockRejectedValue(new Error('ipc down'));

      const result = await generateCardsFromSelection({
        selectedText: '这是一段足够长的选中文本用于制卡',
        t,
      });

      expect(result).toEqual({
        ok: false,
        reason: 'generate_failed',
        error: expect.stringContaining('ipc down'),
      });
      expect(mockShowGlobalNotification).toHaveBeenCalledWith('error', expect.any(String));
    });
  });
});

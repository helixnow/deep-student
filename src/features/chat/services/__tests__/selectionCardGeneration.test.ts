import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGenerateCards,
  mockWaitForReady,
  mockShowGlobalNotification,
  mockInvoke,
} = vi.hoisted(() => ({
  mockGenerateCards: vi.fn(),
  mockWaitForReady: vi.fn(),
  mockShowGlobalNotification: vi.fn(),
  mockInvoke: vi.fn(),
}));

vi.mock('@/components/anki/cardforge', () => ({
  ChatV2AnkiAdapter: {
    generateCards: mockGenerateCards,
  },
  cardAgent: {
    waitForReady: mockWaitForReady,
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
    mockWaitForReady.mockResolvedValue(true);
    mockGenerateCards.mockResolvedValue({ ok: true, documentId: 'doc-1', cards: [] });
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
      expect(mockGenerateCards).not.toHaveBeenCalled();
      expect(mockShowGlobalNotification).toHaveBeenCalledWith('warning', expect.any(String));
    });

    it('waits for cardAgent readiness and calls adapter with short-text quota', async () => {
      const selectedText = '这是一段足够长的选中文本用于制卡';
      const result = await generateCardsFromSelection({
        selectedText,
        sessionId: 'sess_abc',
        contextBefore: '前文上下文',
        contextAfter: '后文上下文',
        t,
      });

      expect(mockWaitForReady).toHaveBeenCalledTimes(1);
      expect(mockGenerateCards).toHaveBeenCalledTimes(1);
      const [content, options] = mockGenerateCards.mock.calls[0];
      expect(content).toContain(selectedText);
      expect(content).toContain('前文上下文');
      expect(content).toContain('后文上下文');
      expect(options).toMatchObject({ maxCards: DEFAULT_SELECTION_MAX_CARDS });
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

    it('toasts failure when adapter returns ok:false', async () => {
      mockGenerateCards.mockResolvedValue({ ok: false, error: 'boom' });

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
  });
});

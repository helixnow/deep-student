import { describe, it, expect, beforeEach } from 'vitest';
import { mergeTranslationBriefingMetrics } from '@/features/generative-ui/utils/mergeTranslationBriefingMetrics';
import type { TranslationStreamSnapshot } from '@/translation/translationStreamBridge';

const baseStream = (patch: Partial<TranslationStreamSnapshot>): TranslationStreamSnapshot => ({
  isTranslating: false,
  translatedText: '',
  charCount: 0,
  wordCount: 0,
  detectedLang: null,
  isPartialResult: false,
  updatedAt: Date.now(),
  ...patch,
});

describe('mergeTranslationBriefingMetrics', () => {
  it('uses session metrics when no stream snapshot', () => {
    const result = mergeTranslationBriefingMetrics({
      sessionSourceText: 'Hello',
      sessionTranslatedText: '你好',
      stream: null,
    });
    expect(result).toEqual({
      sourceChars: 5,
      translatedChars: 2,
      translatedText: '你好',
      isStreaming: false,
    });
  });

  it('prefers live stream while translating', () => {
    const result = mergeTranslationBriefingMetrics({
      sessionSourceText: 'Hello world',
      sessionTranslatedText: '',
      stream: baseStream({
        isTranslating: true,
        translatedText: '你',
        charCount: 1,
      }),
    });
    expect(result.translatedChars).toBe(1);
    expect(result.isStreaming).toBe(true);
  });

  it('prefers longer stream text after partial completion', () => {
    const result = mergeTranslationBriefingMetrics({
      sessionSourceText: 'Hello world',
      sessionTranslatedText: '你',
      stream: baseStream({
        isTranslating: false,
        translatedText: '你好世界',
        charCount: 4,
      }),
    });
    expect(result.translatedText).toBe('你好世界');
    expect(result.translatedChars).toBe(4);
  });
});

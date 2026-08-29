/**
 * 合并 DSTU session 与 translationStreamBridge 快照，供 TranslationGenerativeBriefing 使用
 */

import type { TranslationStreamSnapshot } from '@/translation/translationStreamBridge';

export interface TranslationBriefingMetrics {
  sourceChars: number;
  translatedChars: number;
  translatedText: string;
  isStreaming: boolean;
}

export function mergeTranslationBriefingMetrics(input: {
  sessionSourceText: string;
  sessionTranslatedText: string;
  stream: TranslationStreamSnapshot | null;
}): TranslationBriefingMetrics {
  const sourceChars = input.sessionSourceText.length;
  const sessionTranslatedText = input.sessionTranslatedText;
  const stream = input.stream;

  if (!stream) {
    return {
      sourceChars,
      translatedChars: sessionTranslatedText.length,
      translatedText: sessionTranslatedText,
      isStreaming: false,
    };
  }

  const preferStream =
    stream.isTranslating ||
    stream.translatedText.length > sessionTranslatedText.length ||
    (stream.translatedText.length > 0 && stream.translatedText !== sessionTranslatedText);

  if (!preferStream) {
    return {
      sourceChars,
      translatedChars: sessionTranslatedText.length,
      translatedText: sessionTranslatedText,
      isStreaming: false,
    };
  }

  return {
    sourceChars,
    translatedChars: stream.translatedText.length,
    translatedText: stream.translatedText,
    isStreaming: stream.isTranslating,
  };
}

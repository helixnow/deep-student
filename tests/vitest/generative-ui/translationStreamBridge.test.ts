import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearTranslationStreamSnapshot,
  publishTranslationStreamSnapshot,
  useTranslationStreamBridge,
} from '@/translation/translationStreamBridge';

describe('translationStreamBridge', () => {
  beforeEach(() => {
    useTranslationStreamBridge.getState().actions.clearAll();
  });

  it('publish and read snapshot by key', () => {
    publishTranslationStreamSnapshot('node-1', {
      isTranslating: true,
      translatedText: 'partial',
      charCount: 7,
      wordCount: 1,
      detectedLang: null,
      isPartialResult: false,
    });

    const snap = useTranslationStreamBridge.getState().snapshots['node-1'];
    expect(snap?.translatedText).toBe('partial');
    expect(snap?.isTranslating).toBe(true);
  });

  it('clear removes snapshot', () => {
    publishTranslationStreamSnapshot('node-2', {
      isTranslating: false,
      translatedText: 'done',
      charCount: 4,
      wordCount: 1,
      detectedLang: 'en',
      isPartialResult: false,
    });
    clearTranslationStreamSnapshot('node-2');
    expect(useTranslationStreamBridge.getState().snapshots['node-2']).toBeUndefined();
  });
});

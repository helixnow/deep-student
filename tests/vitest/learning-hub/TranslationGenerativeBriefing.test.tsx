import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { TranslationGenerativeBriefing } from '@/features/learning-hub/components/TranslationGenerativeBriefing';
import type { TranslationSession } from '@/dstu/adapters/translationDstuAdapter';
import {
  publishTranslationStreamSnapshot,
  useTranslationStreamBridge,
} from '@/translation/translationStreamBridge';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => {
      const map: Record<string, string> = {
        'generativeUi:translation.briefing_label': 'AI 翻译简报',
        'generativeUi:translation.briefing.source_stat_title': '原文字数',
        'generativeUi:translation.briefing.progress_title': '翻译进度',
        'generativeUi:translation.briefing.streaming_progress_title': '翻译进行中',
        'generativeUi:translation.briefing.translated_row': '已译 {{count}} 字',
        'generativeUi:translation.briefing.language_pair_row': '语向',
        'generativeUi:translation.briefing.formality_row': '语气',
        'generativeUi:translation.briefing.domain_row': '领域',
        'generativeUi:translation.briefing.glossary_row': '术语表',
        'generativeUi:translation.briefing.open_settings': '翻译设置',
        'generativeUi:translation.briefing.copy_translation': '复制译文',
        'translation:languages.en': '英语',
        'translation:languages.zh-CN': '简体中文',
        'translation:formality_formal': '正式',
      };
      if (map[key]) {
        return map[key].replace('{{count}}', String(opts?.count ?? ''));
      }
      return opts?.defaultValue ?? key;
    },
  }),
}));

const session: TranslationSession = {
  id: 'tr_demo',
  sourceText: 'Hello world',
  translatedText: '你好世界',
  srcLang: 'en',
  tgtLang: 'zh-CN',
  formality: 'formal',
  domain: 'technical',
  glossary: [['API', '应用程序接口']],
  createdAt: 1,
  updatedAt: 1,
};

describe('TranslationGenerativeBriefing', () => {
  beforeEach(() => {
    useTranslationStreamBridge.getState().actions.clearAll();
  });

  it('renders briefing with source stat', () => {
    render(<TranslationGenerativeBriefing session={session} />);
    expect(screen.getByTestId('translation-generative-briefing')).toBeInTheDocument();
    expect(screen.getByText('AI 翻译简报')).toBeInTheDocument();
    expect(screen.getByText('原文字数')).toBeInTheDocument();
    expect(screen.getByText('11')).toBeInTheDocument();
    expect(document.querySelector('[data-generative-block="chart"]')).toBeTruthy();
    expect(document.querySelector('[data-generative-chart]')).toBeTruthy();
  });

  it('returns null for empty session', () => {
    const { container } = render(
      <TranslationGenerativeBriefing
        session={{ ...session, sourceText: '', translatedText: '' }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('updates progress from stream snapshot while translating', () => {
    publishTranslationStreamSnapshot('stream-node', {
      isTranslating: true,
      translatedText: '你',
      charCount: 1,
      wordCount: 1,
      detectedLang: null,
      isPartialResult: false,
    });

    render(<TranslationGenerativeBriefing session={session} streamKey="stream-node" />);

    expect(screen.getByTestId('translation-generative-briefing')).toHaveAttribute(
      'data-streaming',
      'true',
    );
    expect(screen.getByText('翻译进行中')).toBeInTheDocument();
    expect(screen.getByText('9%')).toBeInTheDocument();
  });
});

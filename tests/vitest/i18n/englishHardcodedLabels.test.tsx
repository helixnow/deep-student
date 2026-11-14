/**
 * Labels the frontend hard-coded in English (card preview controls, generated image alt, crop dialog page alt, chart
 * legend, empty error message) now come from the locale files: en-US keeps the exact English the components rendered
 * before, zh-CN shows Chinese. Brand names moved to existing keys render the same text in both languages.
 */
import path from 'node:path';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import zhCommon from '@/locales/zh-CN/common.json';
import enCommon from '@/locales/en-US/common.json';
import zhChat from '@/locales/zh-CN/chatV2.json';
import enChat from '@/locales/en-US/chatV2.json';
import zhUsage from '@/locales/zh-CN/llm_usage.json';
import enUsage from '@/locales/en-US/llm_usage.json';
import zhSettings from '@/locales/zh-CN/settings.json';
import enSettings from '@/locales/en-US/settings.json';
import zhHub from '@/locales/zh-CN/learningHub.json';
import enHub from '@/locales/en-US/learningHub.json';
import type { AnkiCard } from '@/types';

const { language } = await vi.hoisted(async () => ({ language: (await import('i18next')).createInstance() }));
// The suite's default alias only serves Chinese and would hide a missing English key.
vi.mock('react-i18next', () => vi.importActual<typeof import('react-i18next')>(
  path.resolve(process.cwd(), 'node_modules/react-i18next/dist/es/index.js'),
));

const { Card3DPreview } = await import('@/components/Card3DPreview');
const { ImagePreview } = await import('@/features/chat/plugins/blocks/components/ImagePreview');

const COPY = {
  'zh-CN': { pause: '暂停', play: '播放', goToCard2: '跳转到第 2 张卡片', generatedImage: '生成图片', pageAlt: '第 3 页', tokens: 'Token 数', unknownError: '未知错误' },
  'en-US': { pause: 'Pause', play: 'Play', goToCard2: 'Go to card 2', generatedImage: 'Generated image', pageAlt: 'Page 3', tokens: 'Tokens', unknownError: 'Unknown error' },
} as const;

const cards = Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, front: `front ${i}`, back: `back ${i}`, tags: [], images: [] }) as unknown as AnkiCard);

const ID = 'RF-W09-english-hardcoded-labels-localized';

describe('labels hard-coded in English', () => {
  beforeAll(async () => {
    await language.init({
      lng: 'zh-CN',
      fallbackLng: false,
      defaultNS: 'common',
      ns: ['common', 'chatV2', 'llm_usage', 'settings', 'learningHub'],
      resources: {
        'zh-CN': { common: zhCommon, chatV2: zhChat, llm_usage: zhUsage, settings: zhSettings, learningHub: zhHub },
        'en-US': { common: enCommon, chatV2: enChat, llm_usage: enUsage, settings: enSettings, learningHub: enHub },
      },
      interpolation: { escapeValue: false },
    });
  });
  afterEach(() => cleanup());

  it.each(['zh-CN', 'en-US'] as const)(`${ID}: %s card preview controls, generated image alt and the other labels`, async (lng) => {
    const copy = COPY[lng];
    await language.changeLanguage(lng);
    render(
      <I18nextProvider i18n={language}>
        <Card3DPreview cards={cards} />
        <ImagePreview src="data:image/png;base64,AAAA" />
      </I18nextProvider>,
    );

    expect(document.querySelector('.card-3d-controls .control-btn')?.getAttribute('title')).toBe(copy.play);
    expect(document.querySelectorAll('.nav-dot')[1]?.getAttribute('aria-label')).toBe(copy.goToCard2);
    expect(screen.getByRole('img').getAttribute('alt')).toBe(copy.generatedImage);

    const t = language.getFixedT(lng);
    expect(t('common:card3DPreview.pause')).toBe(copy.pause);
    expect(t('common:question_bank.source_image_page_alt', { page: 3 })).toBe(copy.pageAlt);
    expect(t('llm_usage:tokens')).toBe(copy.tokens);
    expect(t('common:error.unknown_error')).toBe(copy.unknownError);
  });

  it('brand names read from locale keys render the text the components hard-coded, in both languages', () => {
    for (const lng of ['zh-CN', 'en-US'] as const) {
      const t = language.getFixedT(lng);
      expect([
        t('settings:external_search.engine_options.google_cse'),
        t('settings:external_search.engine_options.tavily'),
        t('settings:external_search.engine_options.brave'),
        t('settings:mcp.api_key'),
        t('learningHub:diagnostic.lanceSchema'),
        t('common:app.name'),
      ]).toEqual(['Google CSE', 'Tavily', 'Brave', 'API Key', 'Lance Schema', 'Deep Student']);
    }
  });
});

/**
 * prefers-contrast: more → 根节点 data-contrast
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import { PREFERS_CONTRAST_QUERY } from '@/features/generative-ui/hooks/usePrefersContrast';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        parse_error_title: '无法解析 AI 界面意图',
        parse_error_invalid: '格式无效',
        'chrome.accept': '接受',
        'chrome.regenerate': '重新生成',
        'chrome.dismiss': '忽略',
        'chrome.streaming': '生成中',
        'a11y.region_label': 'AI 生成界面',
        'a11y.text_label': '文本',
      };
      return map[key] ?? (params ? `${key}` : key);
    },
    i18n: { language: 'zh-CN' },
  }),
}));

const TEXT_INTENT = {
  version: '1.1' as const,
  meta: { title: '对比' },
  blocks: [
    {
      type: 'text' as const,
      props: { body: '高对比文本' },
    },
  ],
};

const originalMatchMedia = window.matchMedia;

function mockMatchMedia(contrast: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: String(query).includes('prefers-contrast: more') && contrast,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

afterEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: originalMatchMedia,
  });
});

describe('GenerativeUIRenderer prefers-contrast', () => {
  it('uses the shared prefers-contrast query', () => {
    expect(PREFERS_CONTRAST_QUERY).toBe('(prefers-contrast: more)');
  });

  it('sets data-contrast on the root when the query matches', () => {
    mockMatchMedia(true);
    const { container } = render(<GenerativeUIRenderer intent={TEXT_INTENT} />);

    const root = container.querySelector('[data-generative-ui]');
    expect(root).toHaveAttribute('data-contrast', 'true');
    expect(window.matchMedia).toHaveBeenCalledWith(PREFERS_CONTRAST_QUERY);
  });

  it('does not set data-contrast when the query does not match', () => {
    mockMatchMedia(false);
    const { container } = render(<GenerativeUIRenderer intent={TEXT_INTENT} />);

    expect(container.querySelector('[data-generative-ui]')).not.toHaveAttribute('data-contrast');
  });
});

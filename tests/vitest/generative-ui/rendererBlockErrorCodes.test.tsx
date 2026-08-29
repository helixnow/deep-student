/**
 * Invalid-block Alerts 挂 data-block-error-codes：
 * unknown type → unknown-type；props 校验失败 → classify 后的稳定 code。
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import '@/features/generative-ui/blocks';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        parse_error_title: '无法解析 AI 界面意图',
        parse_error_invalid: '格式无效',
        unknown_block_title: `未知组件：${params?.type ?? ''}`,
        unknown_block_desc: '已跳过',
        validation_failed_title: `${params?.type ?? ''} 参数校验失败`,
        'chrome.accept': '接受',
        'chrome.regenerate': '重新生成',
        'chrome.dismiss': '忽略',
        'chrome.streaming': '生成中…',
        'a11y.region_label': 'AI 界面',
        'a11y.skip_to_actions': '跳到操作栏',
      };
      return map[key] ?? key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

describe('GenerativeUIRenderer block error codes', () => {
  it('stamps unknown-type on an unregistered widget Alert', () => {
    const { container } = render(
      <GenerativeUIRenderer
        intent={{
          version: '1',
          blocks: [{ type: 'not-a-real-widget', props: {} }],
        }}
        showChrome={false}
      />,
    );

    const invalid = container.querySelector(
      '[data-block-invalid][data-block-error-codes="unknown-type"]',
    );
    expect(invalid).toBeTruthy();
    expect(invalid?.textContent).toContain('未知组件：not-a-real-widget');
  });

  it('stamps non-empty error codes when stat-card title is missing', () => {
    const { container } = render(
      <GenerativeUIRenderer
        intent={{
          version: '1',
          blocks: [{ type: 'stat-card', props: { value: 3 } }],
        }}
        showChrome={false}
      />,
    );

    const invalid = container.querySelector('[data-block-invalid]');
    expect(invalid).toBeTruthy();
    const codes = invalid?.getAttribute('data-block-error-codes');
    expect(codes).toBeTruthy();
    expect(codes?.length).toBeGreaterThan(0);
    expect(invalid?.textContent).toContain('stat-card 参数校验失败');
  });

  it('stamps non-empty error codes when stat-card title is not a string', () => {
    const { container } = render(
      <GenerativeUIRenderer
        intent={{
          version: '1',
          blocks: [{ type: 'stat-card', props: { title: 1, value: 3 } }],
        }}
        showChrome={false}
      />,
    );

    const invalid = container.querySelector('[data-block-invalid]');
    expect(invalid).toBeTruthy();
    const codes = invalid?.getAttribute('data-block-error-codes');
    expect(codes).toBeTruthy();
    expect(codes?.length).toBeGreaterThan(0);
  });
});

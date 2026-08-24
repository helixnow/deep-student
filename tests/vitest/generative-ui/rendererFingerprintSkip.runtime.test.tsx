/**
 * Renderer 成功根挂 data-intent-fingerprint（对 displayIntent，assignStableBlockIds 之前）、
 * 跳到操作栏链接、以及槽位 data-block-id。
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import { GenerativeBlockSlot } from '@/features/generative-ui/components/GenerativeBlockSlot';
import { fingerprintGenerativeUIIntent } from '@/features/generative-ui/utils/fingerprintGenerativeUIIntent';
import type { GenerativeUIIntent } from '@/features/generative-ui/types';
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
        validation_failed_title: '校验失败',
        'chrome.accept': '接受',
        'chrome.regenerate': '重新生成',
        'chrome.dismiss': '忽略',
        'chrome.streaming': '生成中…',
        'a11y.region_label': 'AI 界面',
        'a11y.skip_to_actions': '跳到操作栏',
        'a11y.text_label': '文本',
      };
      return map[key] ?? key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

const SIMPLE_INTENT: GenerativeUIIntent = {
  version: '1',
  blocks: [
    { type: 'stat-card', props: { title: 'Due', value: 3 } },
    { type: 'text', props: { body: 'hello-body' } },
  ],
};

describe('GenerativeUIRenderer fingerprint + skip-to-actions + slot blockId', () => {
  it('fingerprints displayIntent, exposes skip link, and stamps generated data-block-id', () => {
    const { container } = render(
      <GenerativeUIRenderer intent={SIMPLE_INTENT} showChrome={false} />,
    );

    const root = container.querySelector('[data-generative-ui]');
    expect(root).toBeTruthy();
    expect(root).toHaveAttribute(
      'data-intent-fingerprint',
      fingerprintGenerativeUIIntent(SIMPLE_INTENT),
    );

    const skip = container.querySelector('a[data-skip-to-actions]');
    expect(skip).toBeTruthy();
    expect(skip).toHaveAttribute('href', '#generative-ui-actions');
    expect(skip).toHaveClass('sr-only', 'focus:not-sr-only');
    expect(skip?.textContent).toBe('跳到操作栏');
    expect(root?.firstElementChild).toBe(skip);

    const grid = container.querySelector('[data-layout-mode]');
    expect(grid).toHaveAttribute('id', 'generative-ui-actions');

    const statSlot = container.querySelector('[data-generative-block="stat-card"]');
    const textSlot = container.querySelector('[data-generative-block="text"]');
    expect(statSlot).toHaveAttribute('data-block-id', 'gen-block-stat-card-0');
    expect(textSlot).toHaveAttribute('data-block-id', 'gen-block-text-1');
  });

  it('omits data-intent-fingerprint on the streaming-empty root', () => {
    const { container } = render(
      <GenerativeUIRenderer intent="not-json" isStreaming showChrome={false} />,
    );

    const root = container.querySelector('[data-generative-ui]');
    expect(root).toBeTruthy();
    expect(root).toHaveAttribute('data-streaming');
    expect(root).not.toHaveAttribute('data-intent-fingerprint');
    expect(container.querySelector('[data-skip-to-actions]')).toBeNull();
  });
});

describe('GenerativeBlockSlot data-block-id', () => {
  it('omits data-block-id when blockId is missing or empty', () => {
    const { container, rerender } = render(
      <GenerativeBlockSlot type="text" layoutMode="stack">
        <span>slot</span>
      </GenerativeBlockSlot>,
    );
    expect(container.querySelector('[data-generative-block="text"]')).not.toHaveAttribute(
      'data-block-id',
    );

    rerender(
      <GenerativeBlockSlot type="text" layoutMode="stack" blockId="">
        <span>slot</span>
      </GenerativeBlockSlot>,
    );
    expect(container.querySelector('[data-generative-block="text"]')).not.toHaveAttribute(
      'data-block-id',
    );
  });
});


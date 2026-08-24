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
        'chrome.stream_done': '生成完成',
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

const ACTION_INTENT: GenerativeUIIntent = {
  version: '1',
  blocks: [
    { type: 'text', props: { body: 'hello-body' } },
    {
      type: 'action-bar',
      props: { actions: [{ id: 'copy-intent', label: 'Copy' }] },
    },
  ],
};

describe('GenerativeUIRenderer fingerprint + skip-to-actions + slot blockId', () => {
  it('fingerprints displayIntent, exposes skip link only with an action-bar, and stamps generated data-block-id', () => {
    const { container } = render(
      <GenerativeUIRenderer intent={SIMPLE_INTENT} showChrome={false} />,
    );

    const root = container.querySelector('[data-generative-ui]');
    expect(root).toBeTruthy();
    expect(root).toHaveAttribute(
      'data-intent-fingerprint',
      fingerprintGenerativeUIIntent(SIMPLE_INTENT),
    );
    expect(container.querySelector('a[data-skip-to-actions]')).toBeNull();

    const { container: actionContainer } = render(
      <GenerativeUIRenderer intent={ACTION_INTENT} showChrome={false} />,
    );
    const actionRoot = actionContainer.querySelector('[data-generative-ui]');
    const skip = actionContainer.querySelector('a[data-skip-to-actions]');
    expect(skip).toBeTruthy();
    expect(skip).toHaveClass('sr-only', 'focus:not-sr-only');
    expect(skip?.textContent).toBe('跳到操作栏');
    expect(actionRoot?.firstElementChild).toBe(skip);

    const grid = actionContainer.querySelector('[data-layout-mode]');
    const actionSlot = actionContainer.querySelector('[data-generative-block="action-bar"]');
    expect(grid).not.toHaveAttribute('id');
    expect(actionSlot).toHaveAttribute('id');
    expect(actionSlot?.id).toMatch(/^generative-ui-actions-/);
    expect(actionSlot).toHaveAttribute('tabindex', '-1');
    expect(skip).toHaveAttribute('href', `#${actionSlot?.id}`);
    expect(document.getElementById(actionSlot?.id ?? '')).toBe(actionSlot);

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

  it('uses a distinct in-renderer target for every skip link', () => {
    const { container } = render(
      <>
        <GenerativeUIRenderer intent={ACTION_INTENT} showChrome={false} />
        <GenerativeUIRenderer intent={ACTION_INTENT} showChrome={false} />
      </>,
    );

    const roots = [...container.querySelectorAll<HTMLElement>('[data-generative-ui]')];
    expect(roots).toHaveLength(2);
    const targetIds = roots.map((root) => {
      const skip = root.querySelector<HTMLAnchorElement>('[data-skip-to-actions]');
      const target = root.querySelector<HTMLElement>('[data-generative-block="action-bar"]');
      expect(skip).toHaveAttribute('href', `#${target?.id}`);
      expect(document.getElementById(target?.id ?? '')).toBe(target);
      return target?.id;
    });
    expect(new Set(targetIds).size).toBe(2);
  });

  it('preserves the Chrome live region from empty streaming fallback through completion', () => {
    const { container, rerender } = render(
      <GenerativeUIRenderer intent="not-json" isStreaming showChrome />,
    );
    const streamingLiveRegion = container.querySelector('[aria-live="polite"]');
    expect(streamingLiveRegion).toHaveTextContent('生成中…');

    rerender(
      <GenerativeUIRenderer intent={SIMPLE_INTENT} isStreaming={false} showChrome />,
    );

    const completedLiveRegion = container.querySelector('[aria-live="polite"]');
    expect(completedLiveRegion).toBe(streamingLiveRegion);
    expect(completedLiveRegion).toHaveTextContent('生成完成');
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


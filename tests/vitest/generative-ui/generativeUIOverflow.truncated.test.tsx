/**
 * blocks 截断到 32 时 Renderer 必须显示 i18n 提示（data-blocks-truncated），
 * 不得静默丢块。parse API 保持不变。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import { GenerativeUIPanel } from '@/features/generative-ui/components/GenerativeUIPanel';
import { MAX_GENERATIVE_UI_BLOCKS, parseGenerativeUIIntent } from '@/features/generative-ui/schema';
import { normalizeGenerativeUIIntent } from '@/features/generative-ui/utils/normalizeGenerativeUIIntent';
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
        'a11y.region_label': 'AI 生成界面',
        'a11y.text_label': '文本',
        'panel.empty': '暂无 AI 界面内容',
        'overflow.truncated': `组件数量超过上限，仅显示前 ${params?.max ?? MAX_GENERATIVE_UI_BLOCKS} 个`,
      };
      return map[key] ?? key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

function makeBlocks(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    type: 'text' as const,
    id: `b-${i}`,
    props: { body: `block-body-${i}` },
  }));
}

function makeIntent(count: number): GenerativeUIIntent {
  return { version: '1', meta: { title: 'overflow-doc' }, blocks: makeBlocks(count) };
}

function truncatedHint(): HTMLElement {
  return document.querySelector('[data-blocks-truncated]') as HTMLElement;
}

describe('generativeUI overflow truncated hint', () => {
  it('does not treat exactly 32 blocks as truncated without warnings', () => {
    render(<GenerativeUIRenderer intent={makeIntent(MAX_GENERATIVE_UI_BLOCKS)} showChrome={false} />);

    expect(screen.getByText('block-body-0')).toBeInTheDocument();
    expect(screen.getByText(`block-body-${MAX_GENERATIVE_UI_BLOCKS - 1}`)).toBeInTheDocument();
    expect(truncatedHint()).toBeNull();
  });

  it('shows i18n hint when warnings include blocks-truncated', () => {
    render(
      <GenerativeUIRenderer
        intent={makeIntent(4)}
        showChrome={false}
        warnings={['blocks-truncated']}
      />,
    );

    const hint = truncatedHint();
    expect(hint).not.toBeNull();
    expect(hint).toHaveTextContent('组件数量超过上限，仅显示前 32 个');
    expect(screen.getByText('block-body-0')).toBeInTheDocument();
  });

  it('shows hint when truncatedCount is provided', () => {
    render(
      <GenerativeUIRenderer
        intent={makeIntent(MAX_GENERATIVE_UI_BLOCKS)}
        showChrome={false}
        truncatedCount={8}
      />,
    );

    const hint = truncatedHint();
    expect(hint).not.toBeNull();
    expect(hint).toHaveAttribute('data-truncated-count', '8');
    expect(hint).toHaveTextContent('组件数量超过上限，仅显示前 32 个');
  });

  it('caps an object intent over 32 and does not silently drop extras', () => {
    render(<GenerativeUIRenderer intent={makeIntent(40)} showChrome={false} />);

    expect(screen.getByText('block-body-0')).toBeInTheDocument();
    expect(screen.getByText('block-body-31')).toBeInTheDocument();
    expect(screen.queryByText('block-body-32')).not.toBeInTheDocument();
    expect(screen.queryByText('block-body-39')).not.toBeInTheDocument();

    const hint = truncatedHint();
    expect(hint).not.toBeNull();
    expect(hint).toHaveAttribute('data-truncated-count', '8');
    expect(hint).toHaveTextContent('组件数量超过上限，仅显示前 32 个');
  });

  it('recovers a 40-block JSON string and surfaces the recover warning', () => {
    const raw = JSON.stringify(makeIntent(40));
    const parsed = parseGenerativeUIIntent(raw);
    expect(parsed.ok).toBe(false);

    render(<GenerativeUIRenderer intent={raw} showChrome={false} />);

    expect(screen.getByText('block-body-0')).toBeInTheDocument();
    expect(screen.getByText('block-body-31')).toBeInTheDocument();
    expect(screen.queryByText('block-body-32')).not.toBeInTheDocument();

    const hint = truncatedHint();
    expect(hint).not.toBeNull();
    expect(hint).toHaveTextContent('组件数量超过上限，仅显示前 32 个');
    expect(hint).toHaveAttribute('data-truncated-count', '8');
  });

  it('lets Panel pass warnings through to Renderer', () => {
    render(
      <GenerativeUIPanel
        intent={makeIntent(2)}
        showChrome={false}
        warnings={['blocks-truncated']}
        truncatedCount={5}
      />,
    );

    const hint = truncatedHint();
    expect(hint).not.toBeNull();
    expect(hint).toHaveAttribute('data-truncated-count', '5');
    expect(hint).toHaveTextContent('组件数量超过上限，仅显示前 32 个');
  });

  it('normalize result exposes truncated so callers can pass warnings', () => {
    const result = normalizeGenerativeUIIntent(makeIntent(40));
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.warnings).toContain('blocks-truncated');
    expect(result.intent?.blocks).toHaveLength(MAX_GENERATIVE_UI_BLOCKS);

    render(
      <GenerativeUIRenderer
        intent={result.intent!}
        showChrome={false}
        warnings={result.warnings}
      />,
    );
    expect(truncatedHint()).not.toBeNull();
  });

  it('does not show the hint for invalid JSON that cannot be recovered', () => {
    render(<GenerativeUIRenderer intent="{ bad json" showChrome={false} />);
    expect(screen.getByText('无法解析 AI 界面意图')).toBeInTheDocument();
    expect(truncatedHint()).toBeNull();
  });
});

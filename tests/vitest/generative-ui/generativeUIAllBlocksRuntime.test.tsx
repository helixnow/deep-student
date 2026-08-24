/**
 * SOTA 运行时验收 — 14 种内置块经 GenerativeUIRenderer 全量渲染
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { GenerativeUIRenderer, generativeUIRegistry } from '@/features/generative-ui';
import {
  ALL_BLOCK_TYPES,
  buildAllBlocksIntent,
  buildSingleBlockIntent,
} from '@/features/generative-ui/demo/allBlocksFixture';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        parse_error_title: '无法解析',
        unknown_block_title: `未知：${params?.type ?? ''}`,
        unknown_block_desc: '跳过',
        validation_failed_title: '校验失败',
        'chrome.accept': '接受',
        'chrome.regenerate': '重新生成',
        'chrome.dismiss': '忽略',
        'chrome.streaming': '生成中',
        'action.unregistered_hint': '未注册',
        'action.confirm_title': `确认：${params?.label ?? ''}`,
        'action.confirm_desc': '确认描述',
        'action.confirm_execute': '确认执行',
      };
      return map[key] ?? key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/features/mindmap/components/mindmap/MindMapEmbed', () => ({
  MindMapEmbed: () => <div data-testid="mindmap-embed-mock" />,
}));

import '@/features/generative-ui/blocks';

describe('generativeUIAllBlocksRuntime', () => {
  it('registry contains all 14 built-in block types', () => {
    const registered = new Set(generativeUIRegistry.keys());
    for (const type of ALL_BLOCK_TYPES) {
      expect(registered.has(type), `missing registry entry: ${type}`).toBe(true);
    }
  });

  it.each(ALL_BLOCK_TYPES)('renders block type "%s" without validation errors', (blockType) => {
    const intent = buildSingleBlockIntent(blockType);
    const { container } = render(
      <GenerativeUIRenderer intent={intent} showChrome={false} />,
    );
    expect(container.querySelector('[data-generative-validation-error]')).toBeNull();
    expect(container.querySelector('[data-generative-unknown-block]')).toBeNull();
  });

  it('renders combined all-blocks intent in one pass', () => {
    render(<GenerativeUIRenderer intent={buildAllBlocksIntent()} showChrome={false} />);
    expect(screen.getByText('指标')).toBeInTheDocument();
    expect(screen.getByText('正文内容')).toBeInTheDocument();
    expect(document.querySelector('[data-generative-research-plan]')).toBeTruthy();
    expect(document.querySelector('[data-generative-research-report]')).toBeTruthy();
    expect(screen.getByTestId('mindmap-embed-mock')).toBeInTheDocument();
  });
});

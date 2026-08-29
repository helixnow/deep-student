import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import {
  parseGenerativeUIIntent,
  GenerativeUIRenderer,
  generativeUIRegistry,
  tryParsePartialIntent,
} from '@/features/generative-ui';

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
      };
      return map[key] ?? key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/features/mindmap/components/mindmap/MindMapEmbed', () => ({
  MindMapEmbed: (props: { displayTitle?: string; mindmapId?: string; versionId?: string }) => (
    <div
      data-testid="mindmap-embed-mock"
      data-mindmap-id={props.mindmapId}
      data-version-id={props.versionId}
      data-title={props.displayTitle}
    />
  ),
}));

import '@/features/generative-ui/blocks';

const MINDMAP_INTENT = {
  version: '1' as const,
  meta: { title: '知识图谱预览' },
  blocks: [
    {
      type: 'stat-card',
      props: { title: '节点数', value: 12 },
    },
    {
      type: 'mindmap-embed',
      props: {
        versionId: 'mv_e2e_demo',
        title: '本周复习导图',
        height: 320,
      },
    },
  ],
};

describe('mindmap-embed E2E via GenerativeUIRenderer', () => {
  it('parses intent JSON containing mindmap-embed', () => {
    const result = parseGenerativeUIIntent(JSON.stringify(MINDMAP_INTENT));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent.blocks.some((b) => b.type === 'mindmap-embed')).toBe(true);
    }
  });

  it('renders mindmap-embed through full renderer pipeline', async () => {
    render(<GenerativeUIRenderer intent={MINDMAP_INTENT} showChrome={false} />);

    expect(screen.getByText('知识图谱预览')).toBeInTheDocument();
    expect(screen.getByText('节点数')).toBeInTheDocument();
    expect(screen.getByText('本周复习导图')).toBeInTheDocument();

    const embed = await screen.findByTestId('mindmap-embed-mock');
    expect(embed).toHaveAttribute('data-version-id', 'mv_e2e_demo');
    expect(embed).toHaveAttribute('data-title', '本周复习导图');
  });

  it('puts dir="auto" on the mindmap title heading', async () => {
    render(
      <GenerativeUIRenderer
        intent={{
          version: '1',
          blocks: [
            {
              type: 'mindmap-embed',
              props: { versionId: 'mv_dir_auto', title: '复习导图' },
            },
          ],
        }}
        showChrome={false}
      />,
    );

    const title = await screen.findByRole('heading', { name: '复习导图' });
    expect(title.tagName).toBe('H4');
    expect(title).toHaveAttribute('dir', 'auto');
  });

  it('shows validation error when mindmap ref is missing', () => {
    render(
      <GenerativeUIRenderer
        intent={{
          version: '1',
          blocks: [{ type: 'mindmap-embed', props: { title: '无引用' } }],
        }}
        showChrome={false}
      />,
    );
    expect(screen.getByText(/mindmap-embed 参数校验失败/)).toBeInTheDocument();
  });

  it('registry resolves mindmap-embed for streaming partial intent', () => {
    const partial =
      '{"version":"1","blocks":[{"type":"text","props":{"body":"loading"}},{"type":"mindmap-embed","props":{"versionId":"mv_stream","title":"Stream MM"}';
    const intent = tryParsePartialIntent(partial);
    expect(intent?.blocks).toHaveLength(1);
    expect(intent?.blocks[0]?.type).toBe('text');

    const complete = `${partial}}]}`;
    const fullIntent = tryParsePartialIntent(complete);
    expect(fullIntent?.blocks.some((b) => b.type === 'mindmap-embed')).toBe(true);

    const config = generativeUIRegistry.get('mindmap-embed');
    expect(config?.component).toBeDefined();
    expect(config?.allowPartialRender).toBe(false);
  });
});

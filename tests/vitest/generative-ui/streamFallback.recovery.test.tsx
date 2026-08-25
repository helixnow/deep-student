import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderHook, act } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: (ns?: string | string[]) => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const namespace = Array.isArray(ns) ? ns[0] : ns;
      if (namespace === 'common') {
        const common: Record<string, string> = {
          'aiContentLabel.label': 'AI 生成',
          'aiContentLabel.tooltip': 'AI',
          'aiContentLabel.ariaLabel': 'AI',
        };
        return common[key] ?? key;
      }
      const map: Record<string, string> = {
        parse_error_title: '无法解析 AI 界面意图',
        parse_error_invalid: '格式无效',
        unknown_block_title: `未知组件：${params?.type ?? ''}`,
        unknown_block_desc: '已跳过，请检查组件注册表',
        validation_failed_title: `${params?.type ?? ''} 参数校验失败`,
        'chrome.accept': '接受',
        'chrome.regenerate': '重新生成',
        'chrome.dismiss': '忽略',
        'chrome.streaming': '生成中…',
        'a11y.region_label': 'AI 界面',
      };
      return map[key] ?? key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import { GenerativeUIStreamParser } from '@/features/generative-ui/parser';
import {
  appendGenerativeUIStreamContent,
  clearGenerativeUIStreamRegistry,
  finalizeGenerativeUIStream,
  getLastGoodGenerativeUIIntent,
} from '@/features/generative-ui/bridge/generativeUIStreamRegistry';
import { useGenerativeUIStream } from '@/features/generative-ui/hooks/useGenerativeUIStream';
import '@/features/generative-ui/blocks';

const TEST_STREAM_CAP = 128;

const TRUNCATED =
  '{"version":"1","meta":{"title":"半截"},"blocks":[{"type":"text","props":{"body":"keep-me"}},{"type":"stat-card","props":{"title":"T","value":';

describe('stream fallback recovery — renderer', () => {
  it('renders coerce last-good + streaming chrome instead of a destructive page alert', () => {
    const { container } = render(
      <GenerativeUIRenderer intent={TRUNCATED} isStreaming showChrome />,
    );

    expect(screen.queryByText('无法解析 AI 界面意图')).not.toBeInTheDocument();
    expect(screen.getByText('keep-me')).toBeInTheDocument();
    expect(screen.getByText('生成中…')).toBeInTheDocument();
    expect(container.querySelector('[data-generative-ui]')).toHaveAttribute('data-streaming');
    expect(container.querySelector('[data-stream-fallback]')).toBeTruthy();
  });

  it('still shows a parse error when not streaming', () => {
    render(<GenerativeUIRenderer intent="{ bad json" showChrome={false} />);
    expect(screen.getByText('无法解析 AI 界面意图')).toBeInTheDocument();
  });

  it('does not parse or render a valid streaming string over the buffer cap', () => {
    const oversized = JSON.stringify({
      version: '1',
      blocks: [
        {
          type: 'text',
          props: { body: 'x'.repeat(TEST_STREAM_CAP) },
        },
      ],
    });
    const { container } = render(
      <GenerativeUIRenderer
        intent={oversized}
        isStreaming
        showChrome={false}
        maxStreamChars={TEST_STREAM_CAP}
      />,
    );

    expect(container.querySelector('[data-generative-ui]')).toHaveAttribute('data-streaming');
    expect(container.querySelector('[data-generative-block]')).toBeNull();
  });

  it('falls back without rendering a streaming object over the buffer cap', () => {
    const oversized = {
      version: '1' as const,
      blocks: [
        {
          type: 'text',
          props: { body: 'x'.repeat(TEST_STREAM_CAP) },
        },
      ],
    };
    const { container } = render(
      <GenerativeUIRenderer
        intent={oversized}
        isStreaming
        showChrome={false}
        maxStreamChars={TEST_STREAM_CAP}
      />,
    );

    expect(container.querySelector('[data-generative-ui]')).toHaveAttribute(
      'data-stream-fallback',
    );
    expect(container.querySelector('[data-generative-block]')).toBeNull();
  });

  it('marks invalid block props with a warning alert and data-block-invalid', () => {
    const { container } = render(
      <GenerativeUIRenderer
        intent={{ version: '1', blocks: [{ type: 'text', props: {} }] }}
        showChrome={false}
      />,
    );
    const invalid = container.querySelector('[data-block-invalid]');
    expect(invalid).toBeTruthy();
    expect(screen.getByText(/text 参数校验失败/)).toBeInTheDocument();
  });

  it('marks unknown types with data-block-invalid', () => {
    const { container } = render(
      <GenerativeUIRenderer
        intent={{ version: '1', blocks: [{ type: 'unknown-widget', props: {} }] }}
        showChrome={false}
      />,
    );
    expect(container.querySelector('[data-block-invalid]')).toBeTruthy();
    expect(screen.getByText(/未知组件/)).toBeInTheDocument();
  });
});

describe('stream fallback recovery — parser last-good', () => {
  it('keeps earlier good blocks when a later closed block is illegal', () => {
    const parser = new GenerativeUIStreamParser();
    parser.appendChunk(
      '{"version":"1","blocks":[{"type":"text","id":"a","props":{"body":"first"}}',
    );
    const snap = parser.appendChunk(',{"type":"","props":{}},{"type":"text","id":"c","props":{"body":"third"}}');
    expect(snap.intent?.blocks.map((b) => b.id)).toEqual(['a', 'c']);
    expect(snap.warnings).toContain('invalid-block');
    expect(parser.getSnapshot().intent?.blocks[0]?.props?.body).toBe('first');
  });

  it('dedups duplicate ids keeping the first block', () => {
    const parser = new GenerativeUIStreamParser();
    const snap = parser.appendChunk(
      JSON.stringify({
        version: '1',
        blocks: [
          { type: 'text', id: 'same', props: { body: 'one' } },
          { type: 'text', id: 'same', props: { body: 'two' } },
        ],
      }),
    );
    expect(snap.intent?.blocks).toHaveLength(1);
    expect(snap.intent?.blocks[0]?.props?.body).toBe('one');
    expect(snap.warnings.some((w) => w.startsWith('duplicate-id'))).toBe(true);
  });

  it('caps committed blocks at 32 and records a warning', () => {
    const blocks = Array.from({ length: 36 }, (_, i) => ({
      type: 'text',
      id: `n-${i}`,
      props: { body: `b-${i}` },
    }));
    const parser = new GenerativeUIStreamParser();
    const snap = parser.appendChunk(JSON.stringify({ version: '1', blocks }));
    expect(snap.committedBlockCount).toBe(32);
    expect(snap.warnings).toContain('blocks-truncated');
  });
});

describe('stream fallback recovery — registry lastGoodIntent', () => {
  beforeEach(() => {
    clearGenerativeUIStreamRegistry();
  });

  it('records lastGoodIntent and falls back when finalize JSON is incomplete', () => {
    const blockId = 'blk-last-good';
    const good = '{"version":"1","blocks":[{"type":"text","props":{"body":"stable"}}';
    appendGenerativeUIStreamContent(blockId, good);
    expect(getLastGoodGenerativeUIIntent(blockId)?.blocks[0]?.props?.body).toBe('stable');

    appendGenerativeUIStreamContent(blockId, `${good},{"type":`);
    const final = finalizeGenerativeUIStream(blockId);
    expect(final?.blocks).toHaveLength(1);
    expect(final?.blocks[0]?.props?.body).toBe('stable');
    expect(finalizeGenerativeUIStream(blockId)).toBeNull();
  });

  it('recovers last-good when the completed document contains an illegal block', () => {
    const blockId = 'blk-mixed-end';
    const prefix = '{"version":"1","blocks":[{"type":"text","id":"ok","props":{"body":"keep"}}';
    appendGenerativeUIStreamContent(blockId, prefix);
    const complete = `${prefix},{"type":"","props":{}}]}`;
    appendGenerativeUIStreamContent(blockId, complete);
    const final = finalizeGenerativeUIStream(blockId);
    expect(final?.blocks).toHaveLength(1);
    expect(final?.blocks[0]?.id).toBe('ok');
  });
});

describe('stream fallback recovery — useGenerativeUIStream', () => {
  it('finalize falls back to last-good / coerce instead of wiping intent', () => {
    const { result } = renderHook(() => useGenerativeUIStream());
    act(() => {
      result.current.append(
        '{"version":"1","blocks":[{"type":"text","props":{"body":"streamed"}}',
      );
      result.current.append(',{"type":');
    });
    let finalized: ReturnType<typeof result.current.finalize> = null;
    act(() => {
      finalized = result.current.finalize();
    });
    expect(finalized?.blocks[0]?.props?.body).toBe('streamed');
    expect(result.current.partialIntent?.blocks[0]?.props?.body).toBe('streamed');
    expect(result.current.errors.length).toBeGreaterThan(0);
  });
});

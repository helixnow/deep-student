/**
 * Intent schema v1.1 — version + layout（stack/grid）+ span 钳制
 * 兼容策略：完整解析未知 version 失败；流式 parser 降级到 v1 last-good blocks
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import {
  clampGenerativeLayoutUnit,
  generativeUIIntentSchema,
  layoutGridClassName,
  layoutSpanClassName,
  parseGenerativeUIIntent,
  resolveGenerativeLayout,
} from '@/features/generative-ui/schema';
import {
  GenerativeUIStreamParser,
  tryParsePartialIntent,
} from '@/features/generative-ui/parser';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';

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
        'chrome.streaming': '生成中',
      };
      return map[key] ?? key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

const V1_DOC = {
  version: '1' as const,
  meta: { title: 'v1 兼容' },
  blocks: [{ type: 'text', props: { body: 'hello v1' } }],
};

const V11_GRID_DOC = {
  version: '1.1' as const,
  layout: { mode: 'grid' as const, columns: 2 as const },
  meta: { title: 'v1.1 grid' },
  blocks: [
    { type: 'text', props: { body: 'wide' }, span: 2 as const },
    { type: 'stat-card', props: { title: 'Due', value: 3 } },
  ],
};

describe('intent schema v1.1 compatibility', () => {
  it('parses v1 documents without layout and defaults version to 1', () => {
    const noVersion = parseGenerativeUIIntent(
      JSON.stringify({ blocks: [{ type: 'text', props: { body: 'plain' } }] }),
    );
    expect(noVersion.ok).toBe(true);
    if (noVersion.ok) {
      expect(noVersion.intent.version).toBe('1');
      expect(noVersion.intent.layout).toBeUndefined();
      expect(noVersion.intent.blocks).toHaveLength(1);
    }

    const withV1 = parseGenerativeUIIntent(JSON.stringify(V1_DOC));
    expect(withV1.ok).toBe(true);
    if (withV1.ok) {
      expect(withV1.intent.version).toBe('1');
      expect(withV1.intent.layout).toBeUndefined();
    }
  });

  it('parses v1.1 documents with layout and span', () => {
    const result = parseGenerativeUIIntent(JSON.stringify(V11_GRID_DOC));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent.version).toBe('1.1');
      expect(result.intent.layout).toEqual({ mode: 'grid', columns: 2 });
      expect(result.intent.blocks[0]?.span).toBe(2);
    }
  });

  it('rejects unknown version on complete parse (strict fail, not degrade)', () => {
    const result = parseGenerativeUIIntent(
      JSON.stringify({
        version: '2',
        blocks: [{ type: 'text', props: { body: 'future' } }],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.toLowerCase().includes('version'))).toBe(true);
    }
    expect(generativeUIIntentSchema.safeParse({ version: '2', blocks: [] }).success).toBe(false);
  });
});

describe('span / columns clamp', () => {
  it('clamps layout units to 1|2|3', () => {
    expect(clampGenerativeLayoutUnit(0)).toBe(1);
    expect(clampGenerativeLayoutUnit(-4)).toBe(1);
    expect(clampGenerativeLayoutUnit(1)).toBe(1);
    expect(clampGenerativeLayoutUnit(2)).toBe(2);
    expect(clampGenerativeLayoutUnit(3)).toBe(3);
    expect(clampGenerativeLayoutUnit(4)).toBe(3);
    expect(clampGenerativeLayoutUnit(99)).toBe(3);
    expect(clampGenerativeLayoutUnit('x', 2)).toBe(2);
  });

  it('schema clamps illegal span and columns instead of rejecting the document', () => {
    const result = parseGenerativeUIIntent(
      JSON.stringify({
        version: '1.1',
        layout: { mode: 'grid', columns: 9 },
        blocks: [
          { type: 'text', props: { body: 'over' }, span: 5 },
          { type: 'text', props: { body: 'under' }, span: 0 },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent.layout?.columns).toBe(3);
      expect(result.intent.blocks[0]?.span).toBe(3);
      expect(result.intent.blocks[1]?.span).toBe(1);
    }
  });
});

describe('layout class tokens', () => {
  it('maps stack / grid columns to controlled Tailwind classes', () => {
    expect(layoutGridClassName('stack', 1)).toBe('grid gap-3');
    expect(layoutGridClassName('grid', 1)).toBe('grid gap-3');
    expect(layoutGridClassName('grid', 2)).toBe('grid gap-3 sm:grid-cols-2');
    expect(layoutGridClassName('grid', 3)).toBe('grid gap-3 sm:grid-cols-3');
    expect(layoutSpanClassName('stack', 2)).toBeUndefined();
    expect(layoutSpanClassName('grid', 1)).toBeUndefined();
    expect(layoutSpanClassName('grid', 2)).toBe('sm:col-span-2');
    expect(layoutSpanClassName('grid', 3)).toBe('sm:col-span-3');
  });

  it('resolves missing layout as stack / 1 column', () => {
    expect(resolveGenerativeLayout({})).toEqual({ mode: 'stack', columns: 1 });
    expect(resolveGenerativeLayout({ layout: { mode: 'grid' } })).toEqual({
      mode: 'grid',
      columns: 2,
    });
  });
});

describe('GenerativeUIRenderer v1.1 grid', () => {
  it('keeps v1 as stack single-column grid gap-3', () => {
    const { container } = render(
      <GenerativeUIRenderer intent={V1_DOC} showChrome={false} />,
    );
    const layout = container.querySelector('[data-layout-mode]');
    expect(layout).toHaveAttribute('data-layout-mode', 'stack');
    expect(layout).toHaveAttribute('data-layout-columns', '1');
    expect(layout?.className).toBe('grid gap-3');
    expect(container.textContent).toContain('hello v1');
  });

  it('renders v1.1 grid with columns token, span token, and data attributes', () => {
    const { container } = render(
      <GenerativeUIRenderer intent={V11_GRID_DOC} showChrome={false} />,
    );
    const layout = container.querySelector('[data-layout-mode="grid"]');
    expect(layout).toBeTruthy();
    expect(layout).toHaveAttribute('data-layout-columns', '2');
    expect(layout?.className).toContain('grid gap-3');
    expect(layout?.className).toContain('sm:grid-cols-2');
    expect(layout?.className).not.toMatch(/classFromModel|style=/);

    const spanned = container.querySelector('[data-layout-span="2"]');
    expect(spanned).toBeTruthy();
    expect(spanned?.className).toContain('sm:col-span-2');
    expect(container.textContent).toContain('wide');
    expect(container.textContent).toContain('Due');
  });

  it('renders 3-column grid token', () => {
    const { container } = render(
      <GenerativeUIRenderer
        intent={{
          version: '1.1',
          layout: { mode: 'grid', columns: 3 },
          blocks: [{ type: 'text', props: { body: 'c3' }, span: 3 }],
        }}
        showChrome={false}
      />,
    );
    const layout = container.querySelector('[data-layout-mode="grid"]');
    expect(layout).toHaveAttribute('data-layout-columns', '3');
    expect(layout?.className).toContain('sm:grid-cols-3');
    expect(container.querySelector('[data-layout-span="3"]')?.className).toContain('sm:col-span-3');
  });
});

describe('streaming parser v1.1 layout', () => {
  it('emits last-good blocks when layout object is still unclosed', () => {
    const partial =
      '{"version":"1.1","blocks":[{"type":"text","props":{"body":"keep-me"}}],"layout":{"mode":"grid","columns":';
    const intent = tryParsePartialIntent(partial);
    expect(intent).not.toBeNull();
    expect(intent?.blocks).toHaveLength(1);
    expect(intent?.blocks[0]?.type).toBe('text');
    expect(intent?.blocks[0]?.props?.body).toBe('keep-me');
    expect(intent?.version).toBe('1.1');
    expect(intent?.layout).toBeUndefined();
  });

  it('attaches closed layout while a later block is still open', () => {
    const partial =
      '{"version":"1.1","layout":{"mode":"grid","columns":3},"blocks":[{"type":"text","props":{"body":"first"}},{"type":"stat-card","props":{"title":"T","value":';
    const parser = new GenerativeUIStreamParser();
    const snap = parser.appendChunk(partial);
    expect(snap.committedBlockCount).toBe(1);
    expect(snap.intent?.version).toBe('1.1');
    expect(snap.intent?.layout).toEqual({ mode: 'grid', columns: 3 });
    expect(snap.intent?.blocks[0]?.type).toBe('text');
  });

  it('degrades unknown version to v1 last-good blocks during streaming', () => {
    const partial =
      '{"version":"2","blocks":[{"type":"text","props":{"body":"legacy"}}';
    const intent = tryParsePartialIntent(partial);
    expect(intent?.version).toBe('1');
    expect(intent?.blocks).toHaveLength(1);
    expect(intent?.blocks[0]?.props?.body).toBe('legacy');
  });

  it('still incrementally commits v1 streams (backward compatible)', () => {
    const parser = new GenerativeUIStreamParser();
    const snap = parser.appendChunk(
      '{"version":"1","blocks":[{"type":"text","props":{"body":"a"}}',
    );
    expect(snap.intent?.version).toBe('1');
    expect(snap.committedBlockCount).toBe(1);
  });
});

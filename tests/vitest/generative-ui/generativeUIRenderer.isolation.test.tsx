/**
 * Renderer 块级隔离：单块 throw 不拖垮整页；memo 只比 type+props+span；
 * v1.1 grid/span 与流式 fallback 仍有效。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { z } from 'zod';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import { generativeUIRegistry } from '@/features/generative-ui/registry';
import {
  areGenerativeBlockSlotPropsEqual,
  type GenerativeBlockSlotProps,
} from '@/features/generative-ui/components/GenerativeBlockSlot';
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
        block_error_title: `组件渲染失败：${params?.type ?? ''}`,
        block_error_desc: '该块出错，其余内容仍可继续使用',
        'chrome.accept': '接受',
        'chrome.regenerate': '重新生成',
        'chrome.dismiss': '忽略',
        'chrome.streaming': '生成中…',
        'a11y.region_label': 'AI 界面',
        'a11y.text_label': '文本',
      };
      return map[key] ?? key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

const BOOM_TYPE = 'isolation-boom';
const PROBE_TYPE = 'isolation-probe';

const boomSchema = z.object({ id: z.string().optional() }).passthrough();
const probeSchema = z.object({
  id: z.string().optional(),
  body: z.string(),
});

function BoomBlock(): React.ReactElement {
  throw new Error('isolation-boom');
}

let probeRenderCount = 0;
function ProbeBlock({ body }: { body: string }): React.ReactElement {
  probeRenderCount += 1;
  return <div data-testid="isolation-probe">{body}</div>;
}

function registerIsolationBlocks(): void {
  generativeUIRegistry.register({
    type: BOOM_TYPE,
    component: BoomBlock,
    propsSchema: boomSchema,
    description: 'test boom',
  });
  generativeUIRegistry.register({
    type: PROBE_TYPE,
    component: ProbeBlock,
    propsSchema: probeSchema,
    description: 'test probe',
  });
}

function unregisterIsolationBlocks(): void {
  generativeUIRegistry.unregister(BOOM_TYPE);
  generativeUIRegistry.unregister(PROBE_TYPE);
}

const V11_GRID_DOC: GenerativeUIIntent = {
  version: '1.1',
  layout: { mode: 'grid', columns: 2 },
  meta: { title: 'v1.1 grid' },
  blocks: [
    { type: 'text', props: { body: 'wide' }, span: 2 },
    { type: 'stat-card', props: { title: 'Due', value: 3 } },
  ],
};

const TRUNCATED =
  '{"version":"1","meta":{"title":"半截"},"blocks":[{"type":"text","props":{"body":"keep-me"}},{"type":"stat-card","props":{"title":"T","value":';

function slotBase(
  overrides: Partial<GenerativeBlockSlotProps> = {},
): GenerativeBlockSlotProps {
  return {
    type: 'text',
    props: { body: 'hello' },
    span: 1,
    layoutMode: 'grid',
    children: null,
    ...overrides,
  };
}

afterEach(() => {
  unregisterIsolationBlocks();
  probeRenderCount = 0;
  vi.clearAllMocks();
});

describe('GenerativeUIRenderer isolation — error boundary', () => {
  it('keeps sibling blocks when one block throws and marks data-block-error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    registerIsolationBlocks();

    const { container } = render(
      <GenerativeUIRenderer
        intent={{
          version: '1.1',
          layout: { mode: 'grid', columns: 2 },
          blocks: [
            { type: BOOM_TYPE, props: {}, span: 1 },
            { type: 'text', props: { body: 'still-here' }, span: 2 },
          ],
        }}
        showChrome={false}
      />,
    );

    expect(container.querySelector('[data-block-error]')).toBeTruthy();
    expect(container.querySelector(`[data-block-type="${BOOM_TYPE}"]`)).toBeTruthy();
    expect(screen.getByText('still-here')).toBeInTheDocument();
    expect(container.querySelector('[data-generative-ui]')).toBeTruthy();
    expect(screen.queryByText('无法解析 AI 界面意图')).not.toBeInTheDocument();
    expect(container.querySelector('[data-block-type="text"]')).toHaveAttribute(
      'data-layout-span',
      '2',
    );
  });
});

describe('GenerativeUIRenderer isolation — v1.1 layout', () => {
  it('renders v1.1 grid with columns token, span token, and data-block-type', () => {
    const { container } = render(
      <GenerativeUIRenderer intent={V11_GRID_DOC} showChrome={false} />,
    );
    const layout = container.querySelector('[data-layout-mode="grid"]');
    expect(layout).toBeTruthy();
    expect(layout).toHaveAttribute('data-layout-columns', '2');
    expect(layout?.className).toContain('grid gap-3');
    expect(layout?.className).toContain('sm:grid-cols-2');

    const spanned = container.querySelector('[data-layout-span="2"]');
    expect(spanned).toBeTruthy();
    expect(spanned?.className).toContain('sm:col-span-2');
    expect(spanned).toHaveAttribute('data-block-type', 'text');
    expect(container.querySelector('[data-block-type="stat-card"]')).toBeTruthy();
    expect(container.textContent).toContain('wide');
    expect(container.textContent).toContain('Due');
  });
});

describe('GenerativeUIRenderer isolation — stream fallback', () => {
  it('still renders coerce last-good + streaming chrome', () => {
    const { container } = render(
      <GenerativeUIRenderer intent={TRUNCATED} isStreaming showChrome />,
    );

    expect(screen.queryByText('无法解析 AI 界面意图')).not.toBeInTheDocument();
    expect(screen.getByText('keep-me')).toBeInTheDocument();
    expect(screen.getByText('生成中…')).toBeInTheDocument();
    expect(container.querySelector('[data-generative-ui]')).toHaveAttribute('data-streaming');
    expect(container.querySelector('[data-stream-fallback]')).toBeTruthy();
    expect(container.querySelector('[data-block-type="text"]')).toBeTruthy();
  });
});

describe('GenerativeBlockSlot memo — type + props + span', () => {
  it('treats same type/props/span as equal and ignores children identity', () => {
    const prev = slotBase({ children: <span>a</span> });
    const next = slotBase({ children: <span>b</span> });
    expect(areGenerativeBlockSlotPropsEqual(prev, next)).toBe(true);
  });

  it('detects type, props, or span changes', () => {
    const base = slotBase();
    expect(areGenerativeBlockSlotPropsEqual(base, slotBase({ type: 'stat-card' }))).toBe(false);
    expect(
      areGenerativeBlockSlotPropsEqual(base, slotBase({ props: { body: 'other' } })),
    ).toBe(false);
    expect(areGenerativeBlockSlotPropsEqual(base, slotBase({ span: 2 }))).toBe(false);
    expect(areGenerativeBlockSlotPropsEqual(base, slotBase({ props: { body: 'hello' } }))).toBe(
      true,
    );
    expect(
      areGenerativeBlockSlotPropsEqual(
        slotBase({ focusTargetId: 'generative-ui-actions-a' }),
        slotBase({ focusTargetId: 'generative-ui-actions-b' }),
      ),
    ).toBe(false);
  });

  it('skips re-rendering a stable block when a sibling updates', () => {
    registerIsolationBlocks();
    const intentA: GenerativeUIIntent = {
      version: '1.1',
      layout: { mode: 'grid', columns: 2 },
      blocks: [
        { type: PROBE_TYPE, id: 'probe', props: { body: 'stable' }, span: 1 },
        { type: 'text', id: 'sib', props: { body: 'one' }, span: 1 },
      ],
    };

    const { rerender } = render(
      <GenerativeUIRenderer intent={intentA} showChrome={false} />,
    );
    expect(screen.getByTestId('isolation-probe')).toHaveTextContent('stable');
    const afterFirst = probeRenderCount;

    rerender(
      <GenerativeUIRenderer
        intent={{
          ...intentA,
          blocks: [
            { type: PROBE_TYPE, id: 'probe', props: { body: 'stable' }, span: 1 },
            { type: 'text', id: 'sib', props: { body: 'two' }, span: 1 },
          ],
        }}
        showChrome={false}
      />,
    );
    expect(probeRenderCount).toBe(afterFirst);
    expect(screen.getByText('two')).toBeInTheDocument();

    rerender(
      <GenerativeUIRenderer
        intent={{
          ...intentA,
          blocks: [
            { type: PROBE_TYPE, id: 'probe', props: { body: 'changed' }, span: 1 },
            { type: 'text', id: 'sib', props: { body: 'two' }, span: 1 },
          ],
        }}
        showChrome={false}
      />,
    );
    expect(probeRenderCount).toBeGreaterThan(afterFirst);
    expect(screen.getByTestId('isolation-probe')).toHaveTextContent('changed');
  });
});

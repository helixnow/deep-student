/**
 * Chat generative_ui 块 — markdown / chart / steps / table 运行时渲染验收
 *
 * 经 GenerativeUIBlockComponent（toolOutput / content / toolInput）抽出意图，
 * 确认 4 个新 type 不会被当成 unknown / 校验失败，并带上宿主 data 属性。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { createStore } from 'zustand';
import { GenerativeUIBlockComponent } from '@/features/chat/plugins/blocks/generativeUI';
import {
  ALL_BLOCKS_MINIMAL_PROPS,
  buildSingleBlockIntent,
} from '@/features/generative-ui/demo/allBlocksFixture';
import { buildMarkdownIntent } from '@/features/generative-ui/utils/buildMarkdownIntent';
import { buildChartIntent } from '@/features/generative-ui/utils/buildChartIntent';
import { buildStepsIntent } from '@/features/generative-ui/utils/buildStepsIntent';
import { buildTableIntent } from '@/features/generative-ui/utils/buildTableIntent';
import type { ChatStore } from '@/features/chat/core/types';
import type { Block } from '@/features/chat/core/types';
import type { GenerativeUIIntent } from '@/features/generative-ui/types';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        parse_error_title: '无法解析',
        parse_error_invalid: '格式无效',
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
        'a11y.region_label': 'AI 生成界面',
        'a11y.markdown_label': 'Markdown 正文',
        'a11y.chart_label': `${params?.title ?? ''} ${params?.kind ?? ''} 图表`.trim(),
        'a11y.chart_empty': '暂无图表数据',
        'a11y.steps_label': '步骤',
        'a11y.table_label': '表格',
        'a11y.table_caption': '数据表',
        'a11y.step_pending': '未开始',
        'a11y.step_active': '进行中',
        'a11y.step_done': '已完成',
        'a11y.step_error': '失败',
        'a11y.step_skipped': '已跳过',
        'blocks.chart.empty': '暂无图表数据',
        'blocks.chart.a11y_label': `${params?.title ?? ''} ${params?.kind ?? ''} 图表`.trim(),
        'blocks.steps.status_pending': '待开始',
        'blocks.steps.status_active': '进行中',
        'blocks.steps.status_done': '已完成',
        'blocks.steps.status_error': '失败',
        'blocks.steps.status_skipped': '已跳过',
        'blocks.table.empty': '暂无数据',
        'blocks.markdown.empty': '暂无正文',
        'notes.edit_apply': '应用到笔记',
        'notes.edit_dismiss': '忽略建议',
        'research.actions.copy_report': '复制报告',
        'research.actions.export_plan': '导出计划',
        'research.actions.export_intent': '导出全部意图',
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
import { useHpiasEventBridge } from '@/features/generative-ui/hooks/useHpiasEventBridge';

vi.mock('@/features/generative-ui/hooks/useHpiasEventBridge', () => ({
  useHpiasEventBridge: vi.fn(),
}));

const mockedUseHpiasEventBridge = vi.mocked(useHpiasEventBridge);

const NEW_TYPES = ['markdown', 'chart', 'steps', 'table'] as const;

const DATA_ATTR: Record<(typeof NEW_TYPES)[number], string> = {
  markdown: 'data-generative-markdown',
  chart: 'data-generative-chart',
  steps: 'data-generative-steps',
  table: 'data-generative-table',
};

function makeBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: 'gen-new-types-1',
    messageId: 'msg-new-types',
    type: 'generative_ui',
    status: 'success',
    content: '',
    ...overrides,
  };
}

function makeStore() {
  return createStore<ChatStore>(() =>
    ({
      sessionId: 'sess-new-types',
      modeState: null,
    }) as ChatStore,
  );
}

function renderChatBlock(
  intent: GenerativeUIIntent | string,
  extras: {
    isStreaming?: boolean;
    toolOutput?: unknown;
    content?: string;
    toolInput?: unknown;
    blockStreaming?: boolean;
  } = {},
) {
  const { isStreaming, toolOutput, content, toolInput, blockStreaming } = extras;
  return render(
    <GenerativeUIBlockComponent
      block={makeBlock({
        toolOutput: toolOutput ?? { intent, isStreaming: isStreaming ?? false },
        content,
        toolInput,
      })}
      isStreaming={blockStreaming}
      store={makeStore()}
    />,
  );
}

function assertNoInvalidBlocks(container: HTMLElement) {
  expect(container.querySelector('[data-block-invalid]')).toBeNull();
  expect(container.querySelector('[data-generative-validation-error]')).toBeNull();
  expect(container.querySelector('[data-generative-unknown-block]')).toBeNull();
  expect(screen.queryByText(/未知：/)).toBeNull();
  expect(screen.queryByText('校验失败')).toBeNull();
}

function buildFourTypesIntent(overrides: Partial<GenerativeUIIntent> = {}): GenerativeUIIntent {
  return {
    version: '1',
    meta: { title: '四块新 type' },
    blocks: NEW_TYPES.map((type) => ({
      type,
      id: `chat-${type}`,
      props: ALL_BLOCKS_MINIMAL_PROPS[type]!,
    })),
    ...overrides,
  };
}

function installMatchMedia(matches = false) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
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

describe('generativeUIChatBlock new types runtime', () => {
  beforeEach(() => {
    installMatchMedia(false);
    mockedUseHpiasEventBridge.mockClear();
  });

  it.each(NEW_TYPES)(
    'renders %s through Chat generative_ui block without validation errors',
    (blockType) => {
      const { container } = renderChatBlock(buildSingleBlockIntent(blockType));

      expect(container.querySelector('[data-block-type="generative_ui"]')).toBeTruthy();
      expect(container.querySelector(`[data-block-type="${blockType}"]`)).toBeTruthy();
      expect(container.querySelector(`[${DATA_ATTR[blockType]}]`)).toBeTruthy();
      assertNoInvalidBlocks(container);
    },
  );

  it('renders markdown/chart/steps/table together in one Chat block', () => {
    const { container } = renderChatBlock(buildFourTypesIntent());

    expect(container.querySelector('[data-block-type="generative_ui"]')).toBeTruthy();
    expect(container.querySelector('[data-generative-ui]')).toBeTruthy();

    for (const type of NEW_TYPES) {
      expect(
        container.querySelector(`[${DATA_ATTR[type]}]`),
        `missing host marker for ${type}`,
      ).toBeTruthy();
    }

    expect(screen.getByText('说明')).toBeInTheDocument();
    expect(screen.getByText('复习量')).toBeInTheDocument();
    expect(screen.getByText('今日计划')).toBeInTheDocument();
    expect(screen.getByText('复习到期卡')).toBeInTheDocument();
    expect(screen.getByText('错题')).toBeInTheDocument();
    expect(screen.getByText('代数')).toBeInTheDocument();
    expect(container.querySelector('[data-chart-kind="bar"]')).toBeTruthy();
    expect(screen.getByRole('table')).toBeInTheDocument();
    assertNoInvalidBlocks(container);
  });

  it('renders markdown title + sanitized body via Chat MarkdownRenderer', () => {
    const intent = buildMarkdownIntent({
      title: '笔记摘要',
      body: '**加粗要点** 与普通正文',
    });
    const { container } = renderChatBlock(intent);

    expect(container.querySelector('[data-generative-markdown]')).toBeTruthy();
    expect(screen.getByText('笔记摘要')).toBeInTheDocument();
    expect(screen.getByText('加粗要点')).toBeInTheDocument();
    expect(container.querySelector('[data-generative-markdown] strong')).toHaveTextContent('加粗要点');
    assertNoInvalidBlocks(container);
  });

  it.each(['bar', 'line', 'pie'] as const)(
    'renders %s chart kind through Chat generative_ui block',
    (kind) => {
      const intent = buildChartIntent({
        title: `${kind} 图`,
        kind,
        categories: ['周一', '周二'],
        series: [{ name: '张数', values: [3, 5] }],
        labels: { metaTitle: `Chart ${kind}` },
      });
      const { container } = renderChatBlock(intent);

      const chart = container.querySelector('[data-generative-chart]');
      expect(chart).toBeTruthy();
      expect(chart).toHaveAttribute('data-chart-kind', kind);
      expect(screen.getByRole('img')).toHaveAttribute('aria-label', expect.stringContaining(kind));
      assertNoInvalidBlocks(container);
    },
  );

  it('renders steps five statuses through Chat generative_ui block', () => {
    const intent = buildStepsIntent({
      title: '学习计划',
      steps: [
        { label: '预习讲义', status: 'pending', durationLabel: '10 分钟' },
        { label: '复习闪卡', status: 'active' },
        { label: '完成练习', status: 'done' },
        { label: '错题回顾', status: 'error' },
        { label: '选读拓展', status: 'skipped' },
      ],
      labels: { metaTitle: 'Steps' },
    });
    const { container } = renderChatBlock(intent);

    expect(container.querySelector('[data-generative-steps]')).toBeTruthy();
    expect(screen.getByText('学习计划')).toBeInTheDocument();
    expect(screen.getByText('预习讲义')).toBeInTheDocument();
    expect(screen.getByText('10 分钟')).toBeInTheDocument();
    for (const status of ['pending', 'active', 'done', 'error', 'skipped'] as const) {
      expect(
        container.querySelector(`[data-step-status="${status}"]`),
        `missing step status ${status}`,
      ).toBeTruthy();
    }
    expect(container.querySelector('[aria-current="step"]')).toBeTruthy();
    assertNoInvalidBlocks(container);
  });

  it('renders table columns / rows / caption through Chat generative_ui block', () => {
    const intent = buildTableIntent({
      title: '错题表',
      columns: [
        { key: 'topic', label: '主题' },
        { key: 'rate', label: '错误率', align: 'right' },
      ],
      rows: [
        { topic: '代数', rate: '35%' },
        { topic: '几何', rate: 21 },
      ],
      caption: '本周错题',
      labels: { metaTitle: 'Table' },
    });
    const { container } = renderChatBlock(intent);

    expect(container.querySelector('[data-generative-table]')).toBeTruthy();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('错题表')).toBeInTheDocument();
    expect(screen.getByText('主题')).toBeInTheDocument();
    expect(screen.getByText('错误率')).toBeInTheDocument();
    expect(screen.getByText('代数')).toBeInTheDocument();
    expect(screen.getByText('几何')).toBeInTheDocument();
    expect(screen.getByText('本周错题')).toBeInTheDocument();
    assertNoInvalidBlocks(container);
  });

  it('extracts the 4 types from toolOutput JSON string', () => {
    const intent = buildFourTypesIntent();
    const { container } = renderChatBlock(JSON.stringify(intent), {
      toolOutput: { intent: JSON.stringify(intent), isStreaming: false },
    });

    for (const type of NEW_TYPES) {
      expect(container.querySelector(`[${DATA_ATTR[type]}]`)).toBeTruthy();
    }
    assertNoInvalidBlocks(container);
  });

  it('extracts markdown intent from fenced block.content', () => {
    const intent = buildMarkdownIntent({
      title: '流式正文',
      body: '来自 content 字段',
    });
    const { container } = renderChatBlock(intent, {
      toolOutput: null,
      content: `\`\`\`json\n${JSON.stringify(intent)}\n\`\`\``,
    });

    expect(container.querySelector('[data-generative-markdown]')).toBeTruthy();
    expect(screen.getByText('流式正文')).toBeInTheDocument();
    expect(screen.getByText('来自 content 字段')).toBeInTheDocument();
    assertNoInvalidBlocks(container);
  });

  it('extracts table intent from toolInput.intent fallback', () => {
    const intent = buildTableIntent({
      title: '输入表',
      columns: [{ key: 'name', label: '名称' }],
      rows: [{ name: '词条 A' }],
      labels: { metaTitle: 'Input table' },
    });
    const { container } = renderChatBlock(intent, {
      toolOutput: {},
      toolInput: { intent },
    });

    expect(container.querySelector('[data-generative-table]')).toBeTruthy();
    expect(screen.getByText('输入表')).toBeInTheDocument();
    expect(screen.getByText('词条 A')).toBeInTheDocument();
    assertNoInvalidBlocks(container);
  });

  it('renders v1.1 two-column grid of the 4 types through Chat block', () => {
    const intent = buildFourTypesIntent({
      version: '1.1',
      layout: { mode: 'grid', columns: 2 },
      meta: { title: 'v1.1 四块栅格' },
      blocks: NEW_TYPES.map((type) => ({
        type,
        id: `grid-${type}`,
        span: type === 'chart' || type === 'table' ? 2 : 1,
        props: ALL_BLOCKS_MINIMAL_PROPS[type]!,
      })),
    });
    const { container } = renderChatBlock(intent);

    const layout = container.querySelector('[data-layout-mode="grid"]');
    expect(layout).toBeTruthy();
    expect(layout).toHaveAttribute('data-layout-columns', '2');
    expect(layout?.className).toContain('sm:grid-cols-2');
    expect(container.querySelector('[data-layout-span="2"]')).toBeTruthy();
    for (const type of NEW_TYPES) {
      expect(container.querySelector(`[${DATA_ATTR[type]}]`)).toBeTruthy();
    }
    assertNoInvalidBlocks(container);
  });

  it('marks renderer streaming when Chat block is still streaming', () => {
    const intent = buildMarkdownIntent({
      title: '生成中',
      body: '半成品正文',
    });
    const { container } = renderChatBlock(intent, {
      toolOutput: { intent, isStreaming: true },
      blockStreaming: true,
    });

    expect(container.querySelector('[data-generative-ui]')).toHaveAttribute('data-streaming');
    expect(container.querySelector('[data-generative-markdown]')).toBeTruthy();
    expect(screen.queryByText('接受')).toBeNull();
    assertNoInvalidBlocks(container);
  });

  it('renders empty chart / table states through Chat block', () => {
    const intent: GenerativeUIIntent = {
      version: '1',
      blocks: [
        {
          type: 'chart',
          props: { kind: 'bar', categories: ['空'] },
        },
        {
          type: 'table',
          props: {
            columns: [{ key: 'col', label: '列' }],
            rows: [],
          },
        },
      ],
    };
    const { container } = renderChatBlock(intent);

    expect(container.querySelector('[data-generative-chart][data-empty]')).toBeTruthy();
    expect(container.querySelector('[data-generative-table][data-empty]')).toBeTruthy();
    expect(screen.getByText('暂无图表数据')).toBeInTheDocument();
    expect(screen.getByText('暂无数据')).toBeInTheDocument();
    assertNoInvalidBlocks(container);
  });

  it('does not enable HPIAS bridge for markdown/chart/steps/table-only intents', () => {
    renderChatBlock(buildFourTypesIntent());

    expect(mockedUseHpiasEventBridge).toHaveBeenCalledWith({
      enabled: false,
      sessionId: undefined,
    });
  });
});

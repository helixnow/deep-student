/**
 * Wave2-E 第 3 轮（r3-06）独立降级测试 — stats-only failure & 混合态呈现
 *
 * ⚠️ 执行纪律：本文件第 3 轮只写不跑，vitest 统一到第 8 轮执行。
 *
 * 契约对象：
 * 1. AnkiTasksApp.load() 的 list/stats 解耦（台账 P1-3，r1-09 §2 / §7 插入点 6）——
 *    get_anki_stats 单独失败时列表照常渲染/刷新，统计区以非阻断错误条
 *    （anki-tasks-stats-error，role=status）降级，不进整页错误态 / stale banner；
 * 2. failed+running 混合态按「运行中」呈现并叠加非阻断警告徽章（r1-09 §1 / §7 插入点 5）。
 *
 * 溯源：r3-06（独立降级测试）与产品实现者在共享工作区各写了一版同名文件，
 * 本文件为合并版——保留实现对齐断言（wb-at-warning-badge / data-agent-entity），
 * 并入 r3-06 独有场景（stats 失败的刷新不得让列表变 stale；首载 list 失败仍走
 * 整页错误态）。契约锚点记录见 docs/dev/wave2-E-r3-06-tasks-tests.md。
 *
 * mock 结构对齐 AnkiTasksApp.loadError.test.tsx（invoke 响应队列 + 真实 zh-CN 文案；
 * t() 额外支持 defaultValue：statsLoadFailed 词条暂以组件内联 defaultValue 提供，
 * locale 落词条后自动优先取 locale）。
 */
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import zhAnki from '@/locales/zh-CN/anki.json';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@/hooks/useViewVisibility', () => ({ useViewVisibility: () => ({ isActive: false }) }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/layout', () => ({
  useMobileHeader: vi.fn(),
  MobileSlidingLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/shared/CommonTooltip', () => ({
  CommonTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/ui/SegmentedControl', () => ({
  SegmentedControl: () => <div data-testid="segmented-control" />,
}));
vi.mock('@/features/chat/anki', () => ({
  exportCardsAsApkg: vi.fn(async () => ({ success: true })),
}));
vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugLog: { error: vi.fn() },
}));

// 走真实 zh-CN 文案：缺 key 先退 options.defaultValue，再退 key 本身——
// 裸 key 出现在 DOM 即断言失败。
vi.mock('react-i18next', () => {
  const lookup = (key: string): string | undefined => {
    let cursor: unknown = zhAnki;
    for (const part of key.split('.')) {
      if (cursor == null || typeof cursor !== 'object') return undefined;
      cursor = (cursor as Record<string, unknown>)[part];
    }
    return typeof cursor === 'string' ? cursor : undefined;
  };
  return {
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) => {
        const template = lookup(key) ?? (options?.defaultValue as string | undefined);
        if (template == null) return key;
        if (!options) return template;
        return template.replace(
          /\{\{\s*([^}\s]+)\s*\}\}/g,
          (placeholder, name: string) => (options[name] == null ? placeholder : String(options[name])),
        );
      },
      i18n: { language: 'zh-CN' },
    }),
    initReactI18next: { type: '3rdParty', init: () => undefined },
  };
});

import { AnkiTasksApp } from '../AnkiTasksApp';
import type { DocumentSession, AnkiStats } from '../types';

function makeSession(name: string, overrides: Partial<DocumentSession> = {}): DocumentSession {
  return {
    documentId: `doc-${name}`,
    documentName: name,
    sourceSessionId: null,
    totalTasks: 1,
    completedTasks: 1,
    failedTasks: 0,
    activeTasks: 0,
    pausedTasks: 0,
    lastUpdated: '2026-08-20T08:00:00.000Z',
    createdAt: '2026-08-20T08:00:00.000Z',
    // 0 张卡片让文档排行榜不渲染同名条目，会话名在 DOM 中保持唯一
    totalCards: 0,
    ...overrides,
  };
}

const emptyStats: AnkiStats = { totalCards: 0, totalDocuments: 0, errorCards: 0, templateCount: 0 };

const dashboard = zhAnki.taskDashboard;

/** 每次 load 各消费一个结果；`Error` 表示该次调用失败。 */
let sessionResponses: Array<DocumentSession[] | Error>;
let statsResponses: Array<AnkiStats | Error>;

beforeEach(() => {
  sessionResponses = [];
  statsResponses = [];
  invokeMock.mockReset();
  invokeMock.mockImplementation((command: string) => {
    if (command === 'list_document_sessions') {
      const next = sessionResponses.shift();
      if (next === undefined) return Promise.reject(new Error('Unexpected list_document_sessions call'));
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }
    if (command === 'get_anki_stats') {
      const next = statsResponses.shift();
      if (next === undefined) return Promise.reject(new Error('Unexpected get_anki_stats call'));
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }
    return Promise.resolve(false);
  });

  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  // 桌面断点：页头工具条可见，断言不依赖移动端布局分支
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  });
});

describe('AnkiTasksApp stats-only failure (load 拆分)', () => {
  it('get_anki_stats 单独失败时列表照常渲染，仅显示统计错误条', async () => {
    sessionResponses.push([makeSession('list survives')]);
    statsResponses.push(new Error('get_anki_stats is offline'));

    render(<AnkiTasksApp isVisible />);

    // 回归点（拆分前的 bug）：Promise.all 快速失败会把已成功返回的列表一并
    // 丢进整页错误态。拆分后列表数据可得就必须渲染。
    expect(await screen.findByText('list survives')).toBeInTheDocument();

    // 统计错误条可见且非阻断（role=status，不是 alert），并诚实携带底层错误文本
    const statsBanner = await screen.findByTestId('anki-tasks-stats-error');
    expect(statsBanner).toHaveAttribute('role', 'status');
    expect(statsBanner).toHaveTextContent('get_anki_stats is offline');
    // 文案必须走 i18n（locale 词条或 defaultValue），不允许渲染裸 key
    expect(statsBanner.textContent).not.toMatch(/taskDashboard\./);

    // 不得进整页错误态，也不得挂列表 stale banner（列表明明是新鲜的）
    expect(screen.queryByTestId('anki-tasks-load-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('anki-tasks-stale-banner')).not.toBeInTheDocument();
    expect(screen.queryByText(dashboard.empty)).not.toBeInTheDocument();
  });

  it('统计错误条的重试成功后清除错误条', async () => {
    sessionResponses.push([makeSession('doc a')]);
    statsResponses.push(new Error('stats offline'));

    render(<AnkiTasksApp isVisible />);
    const statsBanner = await screen.findByTestId('anki-tasks-stats-error');

    sessionResponses.push([makeSession('doc a')]);
    statsResponses.push(emptyStats);
    fireEvent.click(within(statsBanner).getByRole('button', { name: dashboard.retry }));

    await waitFor(() => {
      expect(screen.queryByTestId('anki-tasks-stats-error')).not.toBeInTheDocument();
    });
    expect(screen.getByText('doc a')).toBeInTheDocument();
  });

  it('stats 失败的刷新仍然刷新列表：新数据落地、不退化成 stale', async () => {
    sessionResponses.push([makeSession('initial doc')]);
    statsResponses.push(emptyStats);

    render(<AnkiTasksApp isVisible />);
    expect(await screen.findByText('initial doc')).toBeInTheDocument();
    expect(screen.queryByTestId('anki-tasks-stats-error')).not.toBeInTheDocument();

    // 刷新：list 带回新数据、stats 失败 → 列表必须换成新数据（不是沿用旧数据），
    // 且不得出现 stale banner（stale 语义只属于「list 刷新失败但有旧数据」）
    sessionResponses.push([makeSession('fresh doc')]);
    statsResponses.push(new Error('stats refresh exploded'));
    fireEvent.click(screen.getByRole('button', { name: dashboard.refresh }));

    const statsBanner = await screen.findByTestId('anki-tasks-stats-error');
    expect(statsBanner).toHaveTextContent('stats refresh exploded');
    expect(screen.getByText('fresh doc')).toBeInTheDocument();
    expect(screen.queryByText('initial doc')).not.toBeInTheDocument();
    expect(screen.queryByTestId('anki-tasks-stale-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('anki-tasks-load-error')).not.toBeInTheDocument();
  });

  it('list 单独失败（stats 正常）仍走既有 stale banner 语义', async () => {
    sessionResponses.push([makeSession('old doc')]);
    statsResponses.push(emptyStats);

    render(<AnkiTasksApp isVisible />);
    expect(await screen.findByText('old doc')).toBeInTheDocument();

    sessionResponses.push(new Error('list offline'));
    statsResponses.push(emptyStats);
    fireEvent.click(screen.getByRole('button', { name: dashboard.refresh }));

    const banner = await screen.findByTestId('anki-tasks-stale-banner');
    expect(banner).toHaveTextContent(dashboard.refreshFailedStale);
    // stats 是成功的，不该出现统计错误条
    expect(screen.queryByTestId('anki-tasks-stats-error')).not.toBeInTheDocument();
    expect(screen.getByText('old doc')).toBeInTheDocument();
  });

  it('首次加载 list 失败（stats 正常）仍走整页错误态，不误报统计降级', async () => {
    sessionResponses.push(new Error('list_document_sessions is offline'));
    statsResponses.push(emptyStats);

    render(<AnkiTasksApp isVisible />);

    // 解耦不得反向弱化：无旧数据时 list 失败仍是整页错误态 + 重试
    // （loadError 测试锁定的契约），且不与空态混淆
    const errorPanel = await screen.findByTestId('anki-tasks-load-error');
    expect(errorPanel).toHaveAttribute('role', 'alert');
    expect(errorPanel).toHaveTextContent(dashboard.loadFailed);
    expect(errorPanel).toHaveTextContent('list_document_sessions is offline');
    expect(screen.queryByText(dashboard.empty)).not.toBeInTheDocument();
    expect(screen.queryByTestId('anki-tasks-stats-error')).not.toBeInTheDocument();
  });
});

describe('AnkiTasksApp failed+running 混合态归 active', () => {
  it('混合态会话显示「进行中」状态标签并叠加非阻断警告徽章', async () => {
    sessionResponses.push([
      makeSession('mixed doc', {
        totalTasks: 10,
        completedTasks: 5,
        failedTasks: 3,
        activeTasks: 2,
      }),
    ]);
    statsResponses.push(emptyStats);

    render(<AnkiTasksApp isVisible />);

    const name = await screen.findByText('mixed doc');
    const row = name.closest('[data-agent-entity]') as HTMLElement;
    expect(row).not.toBeNull();

    // 分组呈现为运行中（旧实现被 failedTasks>0 短路进「失败」）
    expect(within(row).getByText(dashboard.statusActive)).toBeInTheDocument();
    expect(within(row).queryByText(dashboard.statusFailed)).not.toBeInTheDocument();

    // 失败事实以非阻断徽章保留，不改变分组
    const badge = within(row).getByTestId('wb-at-warning-badge');
    expect(badge).toHaveTextContent('3');
  });

  it('纯失败（无运行/暂停）会话仍显示「失败」标签且不叠加徽章', async () => {
    sessionResponses.push([
      makeSession('failed doc', {
        totalTasks: 4,
        completedTasks: 1,
        failedTasks: 3,
      }),
    ]);
    statsResponses.push(emptyStats);

    render(<AnkiTasksApp isVisible />);

    const name = await screen.findByText('failed doc');
    const row = name.closest('[data-agent-entity]') as HTMLElement;

    expect(within(row).getByText(dashboard.statusFailed)).toBeInTheDocument();
    expect(within(row).queryByTestId('wb-at-warning-badge')).not.toBeInTheDocument();
  });

  it('「带警告完成」optional 字段：completed 分组 + 警告徽章', async () => {
    sessionResponses.push([
      makeSession('warned doc', {
        totalTasks: 6,
        completedTasks: 6,
        warningTasks: 2,
      }),
    ]);
    statsResponses.push(emptyStats);

    render(<AnkiTasksApp isVisible />);

    const name = await screen.findByText('warned doc');
    const row = name.closest('[data-agent-entity]') as HTMLElement;

    expect(within(row).getByText(dashboard.statusDone)).toBeInTheDocument();
    expect(within(row).getByTestId('wb-at-warning-badge')).toHaveTextContent('2');
  });
});

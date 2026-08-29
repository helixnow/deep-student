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

// 走真实 zh-CN 文案：缺 key 会退化成 key 本身，断言随即失败。
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
        const template = lookup(key);
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

interface TestSession {
  documentId: string;
  documentName: string;
  sourceSessionId: string | null;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  activeTasks: number;
  pausedTasks: number;
  lastUpdated: string;
  createdAt: string;
  totalCards: number;
}

function makeSession(name: string): TestSession {
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
  };
}

const emptyStats = { totalCards: 0, totalDocuments: 0, errorCards: 0, templateCount: 0 };

const dashboard = zhAnki.taskDashboard;

describe('AnkiTasksApp load failures', () => {
  /** 每次 load 消费一个结果；`Error` 表示该次 list_document_sessions 失败。 */
  let sessionResponses: Array<TestSession[] | Error>;

  beforeEach(() => {
    sessionResponses = [];
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_document_sessions') {
        const next = sessionResponses.shift();
        if (next === undefined) return Promise.reject(new Error('Unexpected list_document_sessions call'));
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      }
      if (command === 'get_anki_stats') return Promise.resolve(emptyStats);
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

  it('reports a first-load failure as an error with retry, not as "no tasks yet"', async () => {
    sessionResponses.push(new Error('list_document_sessions is offline'));

    render(<AnkiTasksApp isVisible />);

    const errorPanel = await screen.findByTestId('anki-tasks-load-error');
    expect(errorPanel).toHaveAttribute('role', 'alert');
    expect(errorPanel).toHaveTextContent(dashboard.loadFailed);
    expect(errorPanel).toHaveTextContent('list_document_sessions is offline');
    // 回归点：失败过去与真正的空后端渲染同一个「暂无制卡任务」空态。
    expect(screen.queryByText(dashboard.empty)).not.toBeInTheDocument();
    expect(screen.queryByText(dashboard.emptyHint)).not.toBeInTheDocument();

    sessionResponses.push([makeSession('recovered doc')]);
    fireEvent.click(screen.getByRole('button', { name: dashboard.retry }));

    expect(await screen.findByText('recovered doc')).toBeInTheDocument();
    expect(screen.queryByTestId('anki-tasks-load-error')).not.toBeInTheDocument();
  });

  it('keeps the last known sessions behind a stale banner when a refresh fails', async () => {
    sessionResponses.push([makeSession('already loaded doc')]);

    render(<AnkiTasksApp isVisible />);
    expect(await screen.findByText('already loaded doc')).toBeInTheDocument();
    expect(screen.queryByTestId('anki-tasks-stale-banner')).not.toBeInTheDocument();

    sessionResponses.push(new Error('refresh is offline'));
    fireEvent.click(screen.getByRole('button', { name: dashboard.refresh }));

    const banner = await screen.findByTestId('anki-tasks-stale-banner');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveTextContent(dashboard.refreshFailedStale);
    // 有旧数据时不该退化成整屏错误态，行仍要留在原地
    expect(screen.getByText('already loaded doc')).toBeInTheDocument();
    expect(screen.queryByTestId('anki-tasks-load-error')).not.toBeInTheDocument();

    sessionResponses.push([makeSession('fresh doc')]);
    fireEvent.click(within(banner).getByRole('button', { name: dashboard.retry }));

    expect(await screen.findByText('fresh doc')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByTestId('anki-tasks-stale-banner')).not.toBeInTheDocument();
    });
  });
});

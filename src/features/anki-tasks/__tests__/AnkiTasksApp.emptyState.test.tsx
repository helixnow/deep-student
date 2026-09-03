import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, visibilityMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  visibilityMock: vi.fn(() => ({ isActive: false })),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@/hooks/useViewVisibility', () => ({ useViewVisibility: visibilityMock }));
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

const emptyStats = {
  totalCards: 0,
  totalDocuments: 0,
  errorCards: 0,
  templateCount: 0,
};

function setupInvoke(sessions: TestSession[]) {
  invokeMock.mockReset();
  invokeMock.mockImplementation((command: string) => {
    if (command === 'list_document_sessions') return Promise.resolve(sessions);
    if (command === 'get_anki_stats') return Promise.resolve(emptyStats);
    if (command === 'get_prevent_sleep' || command === 'set_prevent_sleep') {
      return Promise.resolve(false);
    }
    return Promise.resolve(null);
  });
}

async function findEmptyState(container: HTMLElement): Promise<HTMLElement> {
  await screen.findByText('taskDashboard.empty');
  const empty = container.querySelector<HTMLElement>('.wb-at-empty');
  expect(empty).not.toBeNull();
  return empty!;
}

describe('AnkiTasksApp 空态引导与重试入口', () => {
  beforeEach(() => {
    visibilityMock.mockClear();
    visibilityMock.mockReturnValue({ isActive: false });
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    // matchMedia matches=true → isSmallScreen=false（桌面布局，行内操作簇可见）
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

  it('无任务空态给出双引导：去聊天（主）+ 打开模板库（次）', async () => {
    setupInvoke([]);
    const onNavigateToChat = vi.fn();
    const onOpenTemplateManagement = vi.fn();

    const { container } = render(
      <AnkiTasksApp
        isVisible
        onNavigateToChat={onNavigateToChat}
        onOpenTemplateManagement={onOpenTemplateManagement}
      />,
    );

    const empty = await findEmptyState(container);
    expect(within(empty).getByText('taskDashboard.emptyHint')).toBeInTheDocument();

    fireEvent.click(within(empty).getByRole('button', { name: 'taskDashboard.goToChat' }));
    expect(onNavigateToChat).toHaveBeenCalledWith('__new__');

    fireEvent.click(within(empty).getByRole('button', { name: 'taskDashboard.openTemplateLib' }));
    expect(onOpenTemplateManagement).toHaveBeenCalledTimes(1);
  });

  it('未接入模板库回调时空态只保留去聊天引导', async () => {
    setupInvoke([]);
    const { container } = render(<AnkiTasksApp isVisible onNavigateToChat={vi.fn()} />);

    const empty = await findEmptyState(container);
    expect(within(empty).getByRole('button', { name: 'taskDashboard.goToChat' })).toBeInTheDocument();
    expect(within(empty).queryByRole('button', { name: 'taskDashboard.openTemplateLib' })).toBeNull();
  });

  it('失败 + 暂停并存的会话行内仍常显重试入口', async () => {
    setupInvoke([
      {
        documentId: 'doc-mixed',
        documentName: 'mixed session',
        sourceSessionId: null,
        totalTasks: 10,
        completedTasks: 4,
        failedTasks: 3,
        activeTasks: 0,
        pausedTasks: 3,
        lastUpdated: '2026-07-11T08:00:00.000Z',
        createdAt: '2026-07-11T08:00:00.000Z',
        totalCards: 4,
      },
    ]);

    const { container } = render(<AnkiTasksApp isVisible />);

    // 会话名会同时出现在关注条与列表行，此处只等待渲染完成
    expect((await screen.findAllByText('mixed session')).length).toBeGreaterThan(0);
    const row = container.querySelector<HTMLElement>('.wb-at-row');
    expect(row).not.toBeNull();
    // 修复前行内重试附带 pausedTasks === 0 条件：失败 + 暂停并存时找不到入口
    expect(
      within(row!).getByRole('button', { name: 'taskDashboard.retryFailed' }),
    ).toBeInTheDocument();
  });
});

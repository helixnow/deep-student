/**
 * 闪卡中心「制卡」分区标题契约：经典壳里页面标题由壳层（「闪卡」+ 分区条）承担，
 * 页内不再显示「Anki制卡」；Workbench 窗口保留应用自身名称。
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, useMobileHeaderMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  useMobileHeaderMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@/hooks/useViewVisibility', () => ({ useViewVisibility: () => ({ isActive: false }) }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/layout', () => ({
  useMobileHeader: useMobileHeaderMock,
  MobileSlidingLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/shared/CommonTooltip', () => ({
  CommonTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/ui/SegmentedControl', () => ({
  SegmentedControl: () => <div data-testid="segmented-control" />,
}));
vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugLog: { error: vi.fn() },
}));

import { AnkiTasksApp } from '../AnkiTasksApp';

describe('AnkiTasksApp title inside the flashcards hub', () => {
  beforeEach(() => {
    useMobileHeaderMock.mockClear();
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_document_sessions') return Promise.resolve([]);
      if (command === 'get_anki_stats') return Promise.resolve({ totalCards: 0, totalDocuments: 0, errorCards: 0, templateCount: 0 });
      if (command === 'get_prevent_sleep') return Promise.resolve(false);
      return Promise.resolve(null);
    });
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    // matches=true → isSmallScreen=false（桌面布局）
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

  it('does not repeat the app name as a visible heading in the classic hub', async () => {
    render(<AnkiTasksApp isVisible />);
    const heading = await screen.findByRole('heading', { level: 2 });
    expect(heading).toHaveClass('sr-only');
    expect(heading.textContent).not.toBe('taskDashboard.title');
    expect(useMobileHeaderMock.mock.calls.at(-1)?.[1]?.title).not.toBe('taskDashboard.title');
  });

  it('keeps the app name heading inside a workbench window', async () => {
    render(<AnkiTasksApp isVisible workbenchWindowId="wb-1" />);
    const heading = await screen.findByRole('heading', { level: 2 });
    expect(heading).not.toHaveClass('sr-only');
    expect(heading).toHaveClass('wb-at-title');
  });
});

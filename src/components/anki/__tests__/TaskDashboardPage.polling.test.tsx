import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { TaskDashboardPage } from '../TaskDashboardPage';

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

interface TestStats {
  totalCards: number;
  totalDocuments: number;
  errorCards: number;
  templateCount: number;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeSession(name: string, activeTasks = 0): TestSession {
  return {
    documentId: `doc-${name}`,
    documentName: name,
    sourceSessionId: null,
    totalTasks: Math.max(activeTasks, 1),
    completedTasks: activeTasks > 0 ? 0 : 1,
    failedTasks: 0,
    activeTasks,
    pausedTasks: 0,
    lastUpdated: '2026-07-11T08:00:00.000Z',
    createdAt: '2026-07-11T08:00:00.000Z',
    totalCards: 0,
  };
}

const emptyStats: TestStats = {
  totalCards: 0,
  totalDocuments: 0,
  errorCards: 0,
  templateCount: 0,
};

describe('TaskDashboardPage visibility, polling, and request ordering', () => {
  let sessionResponses: Array<Promise<TestSession[]>>;
  let statsResponses: Array<Promise<TestStats>>;
  let mediaListenerCount: number;

  beforeEach(() => {
    sessionResponses = [];
    statsResponses = [];
    mediaListenerCount = 0;
    visibilityMock.mockClear();
    visibilityMock.mockReturnValue({ isActive: false });
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_prevent_sleep' || command === 'set_prevent_sleep') {
        return Promise.resolve(false);
      }
      if (command === 'list_document_sessions') {
        const response = sessionResponses.shift();
        if (!response) throw new Error('Unexpected list_document_sessions call');
        return response;
      }
      if (command === 'get_anki_stats') {
        const response = statsResponses.shift();
        if (!response) throw new Error('Unexpected get_anki_stats call');
        return response;
      }
      return Promise.resolve(null);
    });

    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn((type: string) => {
          if (type === 'change') mediaListenerCount += 1;
        }),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
      })),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the Workbench visibility override while still calling the legacy visibility hook', async () => {
    sessionResponses.push(Promise.resolve([
      makeSession('row one'),
      makeSession('row two'),
      makeSession('row three'),
    ]));
    statsResponses.push(Promise.resolve(emptyStats));

    render(<TaskDashboardPage isVisible />);

    expect(await screen.findByText('row one')).toBeInTheDocument();
    expect(visibilityMock).toHaveBeenCalledWith('task-dashboard');
    expect(invokeMock).toHaveBeenCalledWith('list_document_sessions', { limit: 500 });
    // One page-level useBreakpoint instance owns five media-query subscriptions;
    // SessionRow must not multiply them by the number of rows.
    expect(mediaListenerCount).toBe(5);
  });

  it('ignores an older visibility-triggered response that settles last', async () => {
    const oldSessions = deferred<TestSession[]>();
    const oldStats = deferred<TestStats>();
    const latestSessions = deferred<TestSession[]>();
    const latestStats = deferred<TestStats>();
    sessionResponses.push(oldSessions.promise, latestSessions.promise);
    statsResponses.push(oldStats.promise, latestStats.promise);

    render(<TaskDashboardPage isVisible />);
    await waitFor(() => {
      expect(invokeMock.mock.calls.filter(([command]) => command === 'list_document_sessions')).toHaveLength(1);
    });

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => {
      expect(invokeMock.mock.calls.filter(([command]) => command === 'list_document_sessions')).toHaveLength(2);
    });

    await act(async () => {
      latestSessions.resolve([makeSession('latest visibility')]);
      latestStats.resolve(emptyStats);
      await Promise.resolve();
    });
    expect(await screen.findByText('latest visibility')).toBeInTheDocument();

    await act(async () => {
      oldSessions.resolve([makeSession('stale visibility')]);
      oldStats.resolve(emptyStats);
      await Promise.resolve();
    });
    expect(screen.queryByText('stale visibility')).not.toBeInTheDocument();
    expect(screen.getByText('latest visibility')).toBeInTheDocument();
  });

  it('ignores an older manual refresh response that settles last', async () => {
    const oldSessions = deferred<TestSession[]>();
    const oldStats = deferred<TestStats>();
    const latestSessions = deferred<TestSession[]>();
    const latestStats = deferred<TestStats>();
    sessionResponses.push(
      Promise.resolve([makeSession('initial')]),
      oldSessions.promise,
      latestSessions.promise,
    );
    statsResponses.push(Promise.resolve(emptyStats), oldStats.promise, latestStats.promise);

    render(<TaskDashboardPage isVisible />);
    expect(await screen.findByText('initial')).toBeInTheDocument();

    const refresh = screen.getByRole('button', { name: 'taskDashboard.refresh' });
    fireEvent.click(refresh);
    fireEvent.click(refresh);

    await act(async () => {
      latestSessions.resolve([makeSession('latest manual')]);
      latestStats.resolve(emptyStats);
      await Promise.resolve();
    });
    expect(await screen.findByText('latest manual')).toBeInTheDocument();

    await act(async () => {
      oldSessions.resolve([makeSession('stale manual')]);
      oldStats.resolve(emptyStats);
      await Promise.resolve();
    });
    expect(screen.queryByText('stale manual')).not.toBeInTheDocument();
    expect(screen.getByText('latest manual')).toBeInTheDocument();
  });

  it('waits for the initial result, then uses 5s for active and 30s for idle', async () => {
    vi.useFakeTimers();
    const initialSessions = deferred<TestSession[]>();
    const initialStats = deferred<TestStats>();
    sessionResponses.push(
      initialSessions.promise,
      Promise.resolve([]),
      Promise.resolve([]),
    );
    statsResponses.push(
      initialStats.promise,
      Promise.resolve(emptyStats),
      Promise.resolve(emptyStats),
    );

    render(<TaskDashboardPage isVisible />);
    const listCallCount = () =>
      invokeMock.mock.calls.filter(([command]) => command === 'list_document_sessions').length;
    expect(listCallCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(listCallCount()).toBe(1);

    await act(async () => {
      initialSessions.resolve([makeSession('active first', 1)]);
      initialStats.resolve(emptyStats);
      await Promise.resolve();
    });

    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(listCallCount()).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(listCallCount()).toBe(2);

    act(() => {
      vi.advanceTimersByTime(29_999);
    });
    expect(listCallCount()).toBe(2);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(listCallCount()).toBe(3);
  });
});

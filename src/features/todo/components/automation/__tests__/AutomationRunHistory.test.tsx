import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomationRun } from '@/features/settings/components/automationSettingsApi';
import { AutomationRunHistory } from '../AutomationRunHistory';

const { launchMock } = vi.hoisted(() => ({ launchMock: vi.fn() }));

vi.mock('@/features/workbench/core/workbenchBus', () => ({
  workbenchBus: { launch: launchMock },
}));

vi.mock('react-i18next', () => {
  const translations: Record<string, string> = {
    'todo:automation.history.title': 'Run history',
    'todo:automation.history.filterByTask': 'Filter by task',
    'todo:automation.history.filterByStatus': 'Filter by status',
    'todo:automation.history.allTasks': 'All tasks',
    'todo:automation.history.filterAll': 'All',
    'todo:automation.history.filterSuccess': 'Succeeded',
    'todo:automation.history.filterFailed': 'Failed',
    'todo:automation.history.filterActive': 'In progress',
    'todo:automation.history.summary': 'Summary',
    'todo:automation.history.error': 'Error',
    'todo:automation.history.copyError': 'Copy error',
    'todo:automation.history.copied': 'Copied',
    'todo:automation.history.copyFailed': 'Copy failed',
    'todo:automation.history.duration': 'Duration',
    'todo:automation.history.scheduledFor': 'Scheduled for',
    'todo:automation.history.startedAt': 'Started at',
    'todo:automation.history.finishedAt': 'Finished at',
    'todo:automation.history.nextAttemptAt': 'Next retry',
    'todo:automation.history.delivered': 'Delivered',
    'todo:automation.history.loading': 'Loading run history',
    'todo:automation.history.showMore': 'Show more',
    'todo:automation.history.retry': 'Retry',
    'todo:automation.history.cancel': 'Cancel',
    'todo:automation.history.viewSession': 'View conversation',
    'todo:automation.history.empty': 'No runs yet',
    'todo:automation.history.emptyHint': 'Runs will show up here once tasks execute',
    'todo:automation.status.queued': 'Queued',
    'todo:automation.status.running': 'Running',
    'todo:automation.status.success': 'Succeeded',
    'todo:automation.status.error': 'Failed',
    'todo:automation.status.unknown': 'Unknown',
    'todo:automation.trigger.manual': 'Manual',
  };
  return {
    initReactI18next: { type: '3rdParty' as const, init: () => undefined },
    useTranslation: () => ({
      t: (key: string, options?: string | Record<string, unknown>) => translations[key]
        ?? (typeof options === 'string' ? options : String(options?.defaultValue ?? key)),
      i18n: { language: 'en-US', resolvedLanguage: 'en-US' },
    }),
  };
});

const baseRun: AutomationRun = {
  id: 'run-1',
  automationId: 'auto-1',
  status: 'success',
  triggerType: 'schedule',
  scheduledFor: '2026-07-19T08:00:00Z',
  attempt: 1,
  maxAttempts: 3,
  startedAt: '2026-07-19T08:00:01Z',
  finishedAt: '2026-07-19T08:01:24Z',
  delivered: ['notification'],
  summary: 'Reviewed 12 cards',
};

const failedRun: AutomationRun = {
  ...baseRun,
  id: 'run-2',
  automationId: 'auto-2',
  status: 'error',
  triggerType: 'manual',
  attempt: 2,
  error: 'boom: model unavailable',
  summary: undefined,
  sessionId: 'sess-42',
};

const runningRun: AutomationRun = {
  ...baseRun,
  id: 'run-3',
  automationId: 'auto-1',
  status: 'running',
  finishedAt: undefined,
  summary: undefined,
};

const automationNames = { 'auto-1': 'Daily review', 'auto-2': 'Weekly digest' };

const noop = () => undefined;

function renderHistory(overrides?: Partial<React.ComponentProps<typeof AutomationRunHistory>>) {
  return render(
    <AutomationRunHistory
      runs={[baseRun, failedRun, runningRun]}
      automationNames={automationNames}
      onRetry={noop}
      onCancel={noop}
      onOpenSession={noop}
      {...overrides}
    />,
  );
}

describe('AutomationRunHistory', () => {
  it('renders one collapsed row per run with names and status pills', () => {
    renderHistory();
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(3);
    // 任务筛选 select 的 option 也含任务名，行级断言收敛到 run 列表内
    const list = within(screen.getByRole('list'));
    expect(list.getAllByText('Daily review').length).toBe(2);
    expect(list.getByText('Weekly digest')).toBeInTheDocument();
    expect(list.getByText('Failed')).toBeInTheDocument();
    // manual 触发才显示 trigger 小标
    expect(screen.getByText('Manual')).toBeInTheDocument();
    // 全部行初始折叠
    for (const row of screen.getAllByRole('button', { expanded: false })) {
      expect(row).toHaveAttribute('aria-controls');
    }
  });

  it('shows the empty state when there are no runs', () => {
    renderHistory({ runs: [] });
    expect(screen.getByText('No runs yet')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('filters by status', () => {
    renderHistory();
    fireEvent.click(screen.getByRole('button', { name: 'Failed', pressed: false }));
    const list = within(screen.getByRole('list'));
    expect(list.queryByText('Daily review')).not.toBeInTheDocument();
    expect(list.getByText('Weekly digest')).toBeInTheDocument();
  });

  it('filters by automation via the task select', () => {
    renderHistory();
    fireEvent.change(screen.getByLabelText('Filter by task'), { target: { value: 'auto-2' } });
    const list = within(screen.getByRole('list'));
    expect(list.queryByText('Daily review')).not.toBeInTheDocument();
    expect(list.getByText('Weekly digest')).toBeInTheDocument();
  });

  it('expands a row inline showing details and actions', () => {
    const onRetry = vi.fn();
    const onOpenSession = vi.fn();
    renderHistory({ onRetry, onOpenSession });

    const rowButton = screen
      .getAllByRole('button', { expanded: false })
      .find((el) => el.textContent?.includes('Weekly digest'));
    expect(rowButton).toBeDefined();
    fireEvent.click(rowButton!);
    expect(rowButton).toHaveAttribute('aria-expanded', 'true');

    expect(screen.getByText('boom: model unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledWith('run-2');
    fireEvent.click(screen.getByRole('button', { name: 'View conversation' }));
    expect(onOpenSession).toHaveBeenCalledWith('sess-42');
  });

  it('shows cancel for active runs and reports the run id', () => {
    const onCancel = vi.fn();
    renderHistory({ onCancel });

    const rowButton = screen
      .getAllByRole('button', { expanded: false })
      .filter((el) => el.textContent?.includes('Daily review'))
      .find((el) => el.textContent?.includes('Running'));
    expect(rowButton).toBeDefined();
    fireEvent.click(rowButton!);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledWith('run-3');
  });

  it('renders day group headers outside of list semantics', () => {
    const { container } = renderHistory();
    // 三条 run 同一天 → 恰好一个分组标题；role=presentation 不计入 listitem
    const headers = container.querySelectorAll('li[role="presentation"]');
    expect(headers.length).toBe(1);
    expect(headers[0].textContent).toBeTruthy();
    expect(screen.getAllByRole('listitem').length).toBe(3);
  });

  it('shows a skeleton while loading with no runs yet', () => {
    renderHistory({ runs: [], loading: true });
    expect(screen.getByTestId('automation-history-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('No runs yet')).not.toBeInTheDocument();
  });

  it('renders long lists incrementally behind a show-more button', () => {
    const manyRuns: AutomationRun[] = Array.from({ length: 45 }, (_, index) => ({
      ...baseRun,
      id: `bulk-${index}`,
    }));
    renderHistory({ runs: manyRuns });

    expect(screen.getAllByRole('listitem').length).toBe(40);
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getAllByRole('listitem').length).toBe(45);
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });

  it('prefers the backend-derived duration_ms over the startedAt/finishedAt diff', () => {
    // startedAt → finishedAt 差值为 83s；后端派生字段说 5s，应以后端为准
    const runWithBackendDuration = {
      ...baseRun,
      durationMs: 5_000,
    } as AutomationRun;
    renderHistory({ runs: [runWithBackendDuration] });
    const list = within(screen.getByRole('list'));
    // 行头与详情字段各渲染一次耗时
    expect(list.getAllByText('5s').length).toBeGreaterThan(0);
    expect(list.queryByText('1m 23s')).not.toBeInTheDocument();
  });

  it('falls back to the timestamp diff when duration_ms is absent', () => {
    renderHistory({ runs: [baseRun] });
    const list = within(screen.getByRole('list'));
    expect(list.getAllByText('1m 23s').length).toBeGreaterThan(0);
  });

  describe('copy error feedback', () => {
    afterEach(() => {
      // 清掉本组用例注入的 navigator.clipboard，避免污染其它用例
      delete (navigator as unknown as Record<string, unknown>).clipboard;
    });

    function expandFailedRow() {
      const rowButton = screen
        .getAllByRole('button', { expanded: false })
        .find((el) => el.textContent?.includes('Weekly digest'));
      fireEvent.click(rowButton!);
    }

    it('shows a transient copied state after a successful copy', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
        configurable: true,
      });
      renderHistory();
      expandFailedRow();

      fireEvent.click(screen.getByRole('button', { name: 'Copy error' }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
      });
      expect(screen.getByRole('status')).toHaveTextContent('Copied');
    });

    it('shows an inline failure state instead of failing silently', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
        configurable: true,
      });
      renderHistory();
      expandFailedRow();

      // jsdom 无 document.execCommand：降级路径也失败 → 走行内失败反馈
      fireEvent.click(screen.getByRole('button', { name: 'Copy error' }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Copy failed' })).toBeInTheDocument();
      });
      expect(screen.getByRole('status')).toHaveTextContent('Copy failed');
    });

    it('does not silently no-op when navigator.clipboard is unavailable', async () => {
      renderHistory();
      expandFailedRow();

      fireEvent.click(screen.getByRole('button', { name: 'Copy error' }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Copy failed' })).toBeInTheDocument();
      });
    });
  });

  it('keeps collapsed detail regions hidden from the accessibility tree', () => {
    renderHistory();
    // 折叠态：详情 region aria-hidden，内部的 Retry/Cancel 不可达
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    const regions = document.querySelectorAll('[role="region"][aria-hidden="true"]');
    expect(regions.length).toBe(3);
  });

  it('falls back to workbenchBus.launch when onOpenSession is omitted', () => {
    launchMock.mockClear();
    renderHistory({ onOpenSession: undefined });

    const rowButton = screen
      .getAllByRole('button', { expanded: false })
      .find((el) => el.textContent?.includes('Weekly digest'));
    fireEvent.click(rowButton!);
    fireEvent.click(screen.getByRole('button', { name: 'View conversation' }));

    expect(launchMock).toHaveBeenCalledWith({
      typeId: 'chat',
      instanceKey: 'sess-42',
      reason: 'api',
    });
  });
});

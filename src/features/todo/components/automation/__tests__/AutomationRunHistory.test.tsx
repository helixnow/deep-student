import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AutomationRun } from '@/features/settings/components/automationSettingsApi';
import { AutomationRunHistory } from '../AutomationRunHistory';

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
    'todo:automation.history.scheduledFor': 'Scheduled for',
    'todo:automation.history.startedAt': 'Started at',
    'todo:automation.history.finishedAt': 'Finished at',
    'todo:automation.history.delivered': 'Delivered',
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
    expect(screen.getAllByText('Daily review').length).toBe(2);
    expect(screen.getByText('Weekly digest')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
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
    expect(screen.queryByText('Daily review')).not.toBeInTheDocument();
    expect(screen.getByText('Weekly digest')).toBeInTheDocument();
  });

  it('filters by automation via the task select', () => {
    renderHistory();
    fireEvent.change(screen.getByLabelText('Filter by task'), { target: { value: 'auto-2' } });
    expect(screen.queryByText('Daily review')).not.toBeInTheDocument();
    expect(screen.getByText('Weekly digest')).toBeInTheDocument();
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
});

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutomationInvoke } from '../automationSettingsApi';

vi.mock('react-i18next', () => {
  const translate = (key: string, options?: Record<string, unknown>) => {
    const name = String(options?.name ?? '');
    const values: Record<string, string> = {
      'settings:automation.title': 'Automations',
      'settings:automation.description': 'Manage scheduled tasks.',
      'settings:automation.capacity': `${String(options?.count ?? '')} / ${String(options?.max ?? '')}`,
      'settings:automation.loading': 'Loading automations',
      'settings:automation.saving': 'Saving',
      'settings:automation.never': 'Not run yet',
      'settings:automation.paused': 'Paused',
      'settings:automation.heartbeat': 'Heartbeat',
      'settings:automation.last_run_relative': `Last run ${String(options?.time ?? '')}`,
      'settings:automation.next_run_relative': `Next run ${String(options?.time ?? '')}`,
      'settings:automation.row_updated_elsewhere': 'This task was updated elsewhere; the list has been refreshed.',
      'settings:automation.action_type.agent_turn': 'Agent task',
      'settings:automation.action_type.notify': 'Notification + todo',
      'settings:automation.schedule.daily': `Every day at ${String(options?.time ?? '')}`,
      'settings:automation.schedule.interval': `Every ${String(options?.count ?? '')} minutes`,
      'settings:automation.actions.refresh': 'Refresh automations',
      'settings:automation.actions.retry': 'Retry',
      'settings:automation.actions.toggle': `Enable or disable ${name}`,
      'settings:automation.actions.run_now': `Run ${name} now`,
      'settings:automation.actions.run_now_short': 'Run now',
      'settings:automation.actions.edit': `Edit ${name}`,
      'settings:automation.actions.edit_short': 'Edit',
      'settings:automation.actions.delete': `Delete ${name}`,
      'settings:automation.actions.delete_short': 'Delete',
      'settings:automation.empty.title': 'No automations yet',
      'settings:automation.empty.description': 'There are no scheduled tasks yet.',
      'settings:automation.empty.cta': 'Create your first automation',
      'settings:automation.create.button': 'New automation',
      'settings:automation.create.title': 'Create automation',
      'settings:automation.create.description': 'Define the task, schedule, and failure recovery policy.',
      'settings:automation.create.submit': 'Create',
      'settings:automation.create.capacity_full': `Capacity reached (${String(options?.max ?? '')}).`,
      'settings:automation.edit.name': 'Name',
      'settings:automation.edit.action_type': 'Action',
      'settings:automation.edit.schedule_kind': 'Schedule',
      'settings:automation.edit.timezone': 'Time zone',
      'settings:automation.edit.catch_up_policy': 'Missed runs',
      'settings:automation.edit.session_mode': 'Agent session',
      'settings:automation.edit.model_id': 'Model configuration ID',
      'settings:automation.edit.default_model': 'Use default model',
      'settings:automation.edit.agent_prompt': 'Agent prompt',
      'settings:automation.edit.agent_prompt_fallback': 'Leave blank to use task instructions',
      'settings:automation.edit.max_retries': 'Failure retries',
      'settings:automation.edit.retry_backoff_seconds': 'Retry delay (seconds)',
      'settings:automation.edit.timeout_seconds': 'Timeout (seconds)',
      'settings:automation.edit.prompt': 'Task instructions',
      'settings:automation.edit.advanced': 'Advanced options',
      'settings:automation.catch_up.run_once': 'Run once after resume',
      'settings:automation.catch_up.catch_up_all': 'Run each missed occurrence',
      'settings:automation.catch_up.skip': 'Skip missed occurrences',
      'settings:automation.session_mode.isolated': 'New session each run',
      'settings:automation.session_mode.named': 'Reuse one session',
      'settings:automation.delete.confirm': 'Delete permanently',
      'settings:automation.delete.inline_confirm': 'Delete this automation? Its run history will be deleted too.',
      'settings:automation.delete.heartbeat_blocked': 'The system heartbeat automation cannot be deleted; you can disable it instead.',
      'settings:automation.notices.created': `Created ${name}.`,
      'settings:automation.notices.started': `Started ${name}.`,
      'settings:automation.notices.updated': `Updated ${name}.`,
      'settings:automation.notices.deleted': `Deleted ${name}.`,
      'settings:automation.notices.enabled': `Enabled ${name}.`,
      'settings:automation.notices.disabled': `Disabled ${name}.`,
      'settings:automation.errors.desktop_only': 'Automation management requires the Deep Student desktop app.',
      'settings:automation.errors.prompt_required': 'Task instructions cannot be empty.',
      'settings:automation.errors.name_required': 'Name cannot be empty.',
      'common:cancel': 'Cancel',
      'common:save': 'Save',
    };
    if (key.startsWith('settings:automation.weekdays.')) return key.split('.').at(-1) ?? '';
    return values[key] ?? key;
  };
  return {
    initReactI18next: { type: '3rdParty' as const, init: () => undefined },
    useTranslation: () => ({
      t: translate,
      i18n: { language: 'en-US', resolvedLanguage: 'en-US' },
    }),
  };
});

const automationItem = {
  id: 'auto_morning',
  version: 7,
  name: 'Morning review',
  schedule: { kind: 'daily' as const, time: '08:00' },
  prompt: 'Review overdue material',
  agentPrompt: 'Review the actual due queue',
  enabled: true,
  actionType: 'agent_turn' as const,
  heartbeat: false,
  sessionMode: 'isolated' as const,
  catchUpPolicy: 'run_once' as const,
  maxRetries: 2,
  retryBackoffSeconds: 60,
  timeoutSeconds: 600,
  lastRunAt: undefined as string | undefined,
  nextTriggerAt: '2026-07-14T08:00:00+08:00',
};

const latestRun = {
  id: 'run_1',
  automationId: 'auto_morning',
  status: 'success',
  triggerType: 'schedule',
  scheduledFor: '2026-07-13T08:00:00+08:00',
  attempt: 1,
  maxAttempts: 3,
  delivered: [] as string[],
};

type StoreState = {
  automations: Array<typeof automationItem>;
  count: number;
  max: number;
  runs: Array<typeof latestRun>;
  loading: boolean;
  error: string | null;
  busyKey: string | null;
  refresh: ReturnType<typeof vi.fn>;
  setEnabled: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  runNow: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
};

const stopSyncMock = vi.fn();
const startAutomationSyncMock = vi.fn(() => stopSyncMock);
let storeState: StoreState;

vi.mock('@/features/todo/stores/useAutomationStore', () => ({
  useAutomationStore: () => storeState,
  startAutomationSync: (...args: unknown[]) => startAutomationSyncMock(...args),
}));

vi.mock('@/features/todo/components/automation/AutomationScheduleEditor', () => ({
  AutomationScheduleEditor: ({
    value,
    onChange,
    disabled,
    idPrefix,
  }: {
    value: { kind: string; time: string; intervalMinutes?: number };
    onChange: (schedule: { kind: string; time: string; intervalMinutes?: number }) => void;
    disabled?: boolean;
    idPrefix: string;
  }) => (
    <div data-testid={`schedule-editor-${idPrefix}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange({ kind: 'interval', time: '', intervalMinutes: 45 })}
      >
        set-interval-45
      </button>
      <span>{value.kind}</span>
    </div>
  ),
}));

vi.mock('@/features/todo/components/automation/automationFormat', () => ({
  formatRelativeTime: (iso: string) => `rel(${iso})`,
}));

vi.mock('@/features/todo/components/automation/AutomationStatusPill', () => ({
  AutomationStatusPill: ({ status }: { status: string }) => (
    <span data-testid="status-pill">{status}</span>
  ),
}));

import { AutomationSettingsSection } from '../AutomationSettingsSection';

const invokeMock = vi.fn();

const buildStoreState = (): StoreState => ({
  automations: [{ ...automationItem, schedule: { ...automationItem.schedule } }],
  count: 1,
  max: 20,
  runs: [{ ...latestRun }],
  loading: false,
  error: null,
  busyKey: null,
  refresh: vi.fn(async () => undefined),
  setEnabled: vi.fn(async () => undefined),
  update: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
  runNow: vi.fn(async () => undefined),
  create: vi.fn(async () => undefined),
});

const renderSection = (props: Partial<React.ComponentProps<typeof AutomationSettingsSection>> = {}) =>
  render(
    <AutomationSettingsSection invoke={invokeMock as AutomationInvoke} {...props} />,
  );

describe('AutomationSettingsSection', () => {
  beforeEach(() => {
    storeState = buildStoreState();
    invokeMock.mockReset();
    startAutomationSyncMock.mockClear();
    stopSyncMock.mockClear();
  });

  it('starts the store sync on mount and stops it on unmount', () => {
    const { unmount } = renderSection();
    expect(startAutomationSyncMock).toHaveBeenCalledTimes(1);
    expect(storeState.refresh).toHaveBeenCalled();
    unmount();
    expect(stopSyncMock).toHaveBeenCalledTimes(1);
  });

  it('shows the desktop-only hint and skips syncing when invoke is null', () => {
    renderSection({ invoke: null });
    expect(screen.getByText('Automation management requires the Deep Student desktop app.')).toBeInTheDocument();
    expect(startAutomationSyncMock).not.toHaveBeenCalled();
  });

  it('renders rows with relative next-run time and the last-run status pill', () => {
    renderSection();
    expect(screen.getByText('Morning review')).toBeInTheDocument();
    expect(screen.getByText('Next run rel(2026-07-14T08:00:00+08:00)')).toBeInTheDocument();
    expect(screen.getByTestId('status-pill')).toHaveTextContent('success');
  });

  it('marks paused automations with a chip and degraded styling', () => {
    storeState.automations = [{ ...automationItem, enabled: false }];
    renderSection();
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.queryByText(/Next run/)).not.toBeInTheDocument();
  });

  it('toggles enabled state through the store', async () => {
    renderSection();
    fireEvent.click(screen.getByRole('switch', { name: 'Enable or disable Morning review' }));
    await waitFor(() => {
      expect(storeState.setEnabled).toHaveBeenCalledWith('auto_morning', 7, false);
    });
  });

  it('runs immediately through the store', async () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Run Morning review now' }));
    await waitFor(() => {
      expect(storeState.runNow).toHaveBeenCalledWith('auto_morning', 7);
    });
  });

  it('only disables controls of the busy row via busyKey prefix matching', () => {
    storeState.automations = [
      { ...automationItem },
      { ...automationItem, id: 'auto_evening', name: 'Evening review' },
    ];
    storeState.count = 2;
    storeState.busyKey = 'run:auto_morning';
    renderSection();
    expect(screen.getByRole('button', { name: 'Run Morning review now' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Run Evening review now' })).toBeEnabled();
    expect(screen.getByRole('switch', { name: 'Enable or disable Evening review' })).toBeEnabled();
  });

  it('expands an inline edit panel and saves through the store contract', async () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Morning review' }));

    const panel = await screen.findByTestId('automation-form-edit');
    expect(panel).toBeInTheDocument();
    expect(screen.getByTestId('schedule-editor-edit-auto_morning')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'set-interval-45' }));
    fireEvent.change(screen.getByLabelText('Task instructions'), {
      target: { value: 'Build a concise review plan' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(storeState.update).toHaveBeenCalledWith({
        automationId: 'auto_morning',
        expectedVersion: 7,
        name: 'Morning review',
        schedule: { kind: 'interval', time: '', intervalMinutes: 45 },
        prompt: 'Build a concise review plan',
        actionType: 'agent_turn',
        agentPrompt: 'Review the actual due queue',
        sessionMode: 'isolated',
        modelId: null,
        catchUpPolicy: 'run_once',
        maxRetries: 2,
        retryBackoffSeconds: 60,
        timeoutSeconds: 600,
      });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('automation-form-edit')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Updated Morning review.')).toBeInTheDocument();
  });

  it('only keeps one panel expanded at a time', async () => {
    storeState.automations = [
      { ...automationItem },
      { ...automationItem, id: 'auto_evening', name: 'Evening review' },
    ];
    storeState.count = 2;
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Morning review' }));
    await screen.findByTestId('schedule-editor-edit-auto_morning');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Evening review' }));
    await screen.findByTestId('schedule-editor-edit-auto_evening');
    expect(screen.queryByTestId('schedule-editor-edit-auto_morning')).not.toBeInTheDocument();
  });

  it('collapses the panel and shows an inline row message on a version conflict', async () => {
    storeState.update.mockRejectedValueOnce(new Error(JSON.stringify({
      code: 'AUTOMATION_VERSION_CONFLICT',
      message: 'Automation changed after it was read.',
      automationId: 'auto_morning',
      expectedVersion: 7,
      currentVersion: 8,
    })));
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Morning review' }));
    fireEvent.change(await screen.findByLabelText('Task instructions'), {
      target: { value: 'My stale edit' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'This task was updated elsewhere; the list has been refreshed.',
    );
    expect(screen.queryByTestId('automation-form-edit')).not.toBeInTheDocument();
    expect(storeState.refresh).toHaveBeenCalledTimes(2); // mount + conflict
  });

  it('requires a second inline confirmation before deleting', async () => {
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Morning review' }));
    expect(screen.getByText('Delete this automation? Its run history will be deleted too.')).toBeInTheDocument();
    expect(storeState.remove).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => {
      expect(storeState.remove).toHaveBeenCalledWith('auto_morning', 7);
    });
  });

  it('auto-dismisses the delete confirmation after five seconds', () => {
    vi.useFakeTimers();
    try {
      renderSection();
      fireEvent.click(screen.getByRole('button', { name: 'Delete Morning review' }));
      expect(screen.getByText('Delete this automation? Its run history will be deleted too.')).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(screen.queryByText('Delete this automation? Its run history will be deleted too.')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('disables deleting heartbeat automations with an explanation', () => {
    storeState.automations = [{ ...automationItem, heartbeat: true }];
    renderSection();
    const deleteButton = screen.getByRole('button', { name: 'Delete Morning review' });
    expect(deleteButton).toBeDisabled();
    expect(deleteButton.parentElement).toHaveAttribute(
      'title',
      'The system heartbeat automation cannot be deleted; you can disable it instead.',
    );
  });

  it('auto-dismisses success notices after three seconds', async () => {
    vi.useFakeTimers();
    try {
      renderSection();
      fireEvent.click(screen.getByRole('button', { name: 'Run Morning review now' }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText('Started Morning review.')).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(3_000);
      });
      expect(screen.queryByText('Started Morning review.')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('creates an automation from the header inline panel in settings mode', async () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /New automation/ }));

    const panel = await screen.findByTestId('automation-form-create');
    expect(panel).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Weekly digest' } });
    fireEvent.change(screen.getByLabelText('Task instructions'), {
      target: { value: 'Summarize the week' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(storeState.create).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Weekly digest',
        prompt: 'Summarize the week',
        enabled: true,
        actionType: 'notify',
      }));
    });
    await waitFor(() => {
      expect(screen.queryByTestId('automation-form-create')).not.toBeInTheDocument();
    });
  });

  it('disables the create entry when capacity is full', () => {
    storeState.count = 20;
    storeState.max = 20;
    renderSection();
    expect(screen.getByRole('button', { name: /New automation/ })).toBeDisabled();
  });

  it('opens the create panel from the empty-state CTA in settings mode', async () => {
    storeState.automations = [];
    storeState.count = 0;
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Create your first automation' }));
    expect(await screen.findByTestId('automation-form-create')).toBeInTheDocument();
  });

  it('dispatches automation:request-create from the empty-state CTA in embedded mode', () => {
    storeState.automations = [];
    storeState.count = 0;
    const requestCreate = vi.fn();
    window.addEventListener('automation:request-create', requestCreate);
    try {
      renderSection({ embedded: true });
      expect(screen.queryByRole('button', { name: /New automation/ })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Create your first automation' }));
      expect(requestCreate).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('automation-form-create')).not.toBeInTheDocument();
    } finally {
      window.removeEventListener('automation:request-create', requestCreate);
    }
  });

  it('shows the capacity counter at the bottom in embedded mode', () => {
    renderSection({ embedded: true });
    expect(screen.getByText('1 / 20')).toBeInTheDocument();
  });

  it('surfaces store errors with a retry action', () => {
    storeState.error = 'automation list failed';
    storeState.automations = [];
    storeState.count = 0;
    renderSection();

    expect(screen.getByRole('alert')).toHaveTextContent('automation list failed');
    expect(screen.queryByText('No automations yet')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(storeState.refresh).toHaveBeenCalledTimes(2); // mount + retry
  });
});

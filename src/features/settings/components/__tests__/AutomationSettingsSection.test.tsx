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
        'settings:automation.capacity': '1 / 20',
        'settings:automation.loading': 'Loading automations',
        'settings:automation.saving': 'Saving',
        'settings:automation.never': 'Not run yet',
        'settings:automation.paused': 'Paused',
        'settings:automation.enabled': 'Enabled',
        'settings:automation.disabled': 'Disabled',
        'settings:automation.heartbeat': 'Heartbeat',
        'settings:automation.prompt_empty': 'No task instructions',
        'settings:automation.last_run': 'Last run',
        'settings:automation.next_run': 'Next run',
        'settings:automation.action_type.agent_turn': 'Agent task',
        'settings:automation.action_type.notify': 'Notification + todo',
        'settings:automation.schedule.daily': 'Every day at 08:00',
        'settings:automation.schedule.interval': 'Every 30 minutes',
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
        'settings:automation.edit.title': `Edit ${name}`,
        'settings:automation.edit.description': 'Change schedule and prompt.',
        'settings:automation.edit.name': 'Name',
        'settings:automation.edit.action_type': 'Action',
        'settings:automation.edit.schedule_kind': 'Schedule',
        'settings:automation.edit.weekday': 'Weekday',
        'settings:automation.edit.day_of_month': 'Day of month',
        'settings:automation.edit.time': 'Time',
        'settings:automation.edit.timezone': 'Time zone',
        'settings:automation.edit.interval_minutes': 'Interval in minutes',
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
        'settings:automation.kind.daily': 'Daily',
        'settings:automation.kind.weekdays': 'Weekdays',
        'settings:automation.kind.weekly': 'Weekly',
        'settings:automation.kind.monthly': 'Monthly',
        'settings:automation.kind.interval': 'Interval',
        'settings:automation.catch_up.run_once': 'Run once after resume',
        'settings:automation.catch_up.catch_up_all': 'Run each missed occurrence',
        'settings:automation.catch_up.skip': 'Skip missed occurrences',
        'settings:automation.session_mode.isolated': 'New session each run',
        'settings:automation.session_mode.named': 'Reuse one session',
        'settings:automation.delete.title': 'Delete automation?',
        'settings:automation.delete.description': `${name} will be permanently deleted.`,
        'settings:automation.delete.confirm': 'Delete permanently',
        'settings:automation.notices.started': `Started ${name}.`,
        'settings:automation.notices.updated': `Updated ${name}.`,
        'settings:automation.notices.deleted': `Deleted ${name}.`,
        'settings:automation.notices.enabled': `Enabled ${name}.`,
        'settings:automation.notices.disabled': `Disabled ${name}.`,
        'settings:automation.errors.version_conflict': 'This automation changed while it was open. Reloaded the latest version.',
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

import { AutomationSettingsSection } from '../AutomationSettingsSection';

const listItem = {
  id: 'auto_morning',
  version: 7,
  name: 'Morning review',
  schedule: { kind: 'daily', time: '08:00' },
  prompt: 'Review overdue material',
  agent_prompt: 'Review the actual due queue',
  enabled: true,
  action_type: 'agent_turn',
  heartbeat: false,
  last_run_at: null,
  next_trigger_at: '2026-07-14T08:00:00+08:00',
};

describe('AutomationSettingsSection', () => {
  const invokeMock = vi.fn();
  let items: typeof listItem[];

  beforeEach(() => {
    items = [{ ...listItem, schedule: { ...listItem.schedule } }];
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'chat_v2_automation_list') {
        return { count: items.length, max: 20, automations: items };
      }
      if (command === 'chat_v2_automation_delete') {
        items = [];
        return { success: true };
      }
      return { success: true };
    });
  });

  const renderSection = () => render(
    <AutomationSettingsSection invoke={invokeMock as AutomationInvoke} />,
  );

  it('loads automations and toggles enabled state through the atomic command', async () => {
    renderSection();

    expect(await screen.findByText('Morning review')).toBeInTheDocument();
    expect(screen.getByText('Review overdue material')).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith('chat_v2_automation_list');

    fireEvent.click(screen.getByRole('switch', { name: 'Enable or disable Morning review' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('chat_v2_automation_set_enabled', {
        automationId: 'auto_morning',
        expectedVersion: 7,
        enabled: false,
      });
    });
  });

  it('edits schedule and prompt using the camelCase request contract', async () => {
    renderSection();
    await screen.findByText('Morning review');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Morning review' }));
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'interval' } });
    fireEvent.change(screen.getByLabelText('Interval in minutes'), { target: { value: '45' } });
    fireEvent.change(screen.getByLabelText('Task instructions'), { target: { value: 'Build a concise review plan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('chat_v2_automation_update', {
        request: {
          automationId: 'auto_morning',
          expectedVersion: 7,
          name: 'Morning review',
          schedule: {
            kind: 'interval',
            time: '',
            intervalMinutes: 45,
          },
          prompt: 'Build a concise review plan',
          actionType: 'agent_turn',
          agentPrompt: 'Review the actual due queue',
          sessionMode: 'isolated',
          modelId: null,
          catchUpPolicy: 'run_once',
          maxRetries: 2,
          retryBackoffSeconds: 60,
          timeoutSeconds: 600,
        },
      });
    });
  });

  it('refreshes the list and closes a stale editor after an OCC conflict', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'chat_v2_automation_list') {
        return { count: items.length, max: 20, automations: items };
      }
      if (command === 'chat_v2_automation_update') {
        items = [{
          ...items[0],
          version: 8,
          name: 'Updated elsewhere',
        }];
        throw new Error(JSON.stringify({
          code: 'AUTOMATION_VERSION_CONFLICT',
          message: 'Automation changed after it was read.',
          automationId: 'auto_morning',
          expectedVersion: 7,
          currentVersion: 8,
          current: items[0],
        }));
      }
      return { success: true };
    });

    renderSection();
    await screen.findByText('Morning review');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Morning review' }));
    fireEvent.change(screen.getByLabelText('Task instructions'), {
      target: { value: 'My stale edit' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This automation changed while it was open. Reloaded the latest version.',
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByText('Updated elsewhere')).toBeInTheDocument();
    expect(invokeMock.mock.calls.filter(([command]) => command === 'chat_v2_automation_list'))
      .toHaveLength(2);
    expect(invokeMock).toHaveBeenCalledWith('chat_v2_automation_update', expect.objectContaining({
      request: expect.objectContaining({
        automationId: 'auto_morning',
        expectedVersion: 7,
      }),
    }));
  });

  it('runs immediately with the existing run-now command', async () => {
    renderSection();
    await screen.findByText('Morning review');

    fireEvent.click(screen.getByRole('button', { name: 'Run Morning review now' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('chat_v2_automation_run_now', {
        automationId: 'auto_morning',
        expectedVersion: 7,
      });
    });
  });

  it('does not delete until the destructive confirmation is accepted', async () => {
    renderSection();
    await screen.findByText('Morning review');

    fireEvent.click(screen.getByRole('button', { name: 'Delete Morning review' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith('chat_v2_automation_delete', expect.anything());

    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('chat_v2_automation_delete', {
        automationId: 'auto_morning',
        expectedVersion: 7,
      });
    });
  });

  it('refreshes when the backend broadcasts an automation change', async () => {
    let eventHandler: ((event: unknown) => void) | undefined;
    const unlisten = vi.fn();
    const listen = vi.fn(async (_eventName: string, handler: (event: unknown) => void) => {
      eventHandler = handler;
      return unlisten;
    });

    const { unmount } = render(
      <AutomationSettingsSection
        invoke={invokeMock as AutomationInvoke}
        listen={listen}
      />,
    );
    await screen.findByText('Morning review');
    expect(listen).toHaveBeenCalledWith('chat_v2://automations_changed', expect.any(Function));

    await act(async () => {
      eventHandler?.({});
    });
    await waitFor(() => {
      expect(invokeMock.mock.calls.filter(([command]) => command === 'chat_v2_automation_list')).toHaveLength(2);
    });

    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('shows an error without also claiming the list is empty', async () => {
    invokeMock.mockRejectedValueOnce(new Error('automation list failed'));
    renderSection();

    expect(await screen.findByRole('alert')).toHaveTextContent('automation list failed');
    expect(screen.queryByText('No automations yet')).not.toBeInTheDocument();
  });
});

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));
vi.mock('@/features/settings/components/AutomationSettingsSection', () => ({
  AutomationSettingsSection: () => <div data-testid="automation-definition-list" />,
}));
vi.mock('react-i18next', () => {
  const translations: Record<string, string> = {
    'todo:automation.title': 'Scheduled tasks',
    'todo:automation.subtitle': 'Reminders and unattended Agent runs',
    'todo:automation.summary': 'Automation summary',
    'todo:automation.enabled': 'Enabled',
    'todo:automation.running': 'Running',
    'todo:automation.failed24h': 'Failed in 24h',
    'todo:automation.next': 'Next run',
    'todo:automation.never': 'None',
    'todo:automation.background': 'Keep running after closing the window',
    'todo:automation.backgroundHint': 'Background hint',
    'todo:automation.history': 'Run history',
    'todo:automation.noHistory': 'No runs yet',
    'todo:automation.new': 'New task',
    'todo:automation.createTitle': 'New scheduled task',
    'todo:automation.name': 'Name',
    'todo:automation.action': 'Action',
    'todo:automation.notify': 'Notification + todo',
    'todo:automation.schedule': 'Schedule',
    'todo:automation.daily': 'Daily',
    'todo:automation.weekdays': 'Weekdays',
    'todo:automation.weekly': 'Weekly',
    'todo:automation.monthly': 'Monthly',
    'todo:automation.interval': 'Fixed interval',
    'todo:automation.time': 'Time',
    'todo:automation.timezone': 'Time zone',
    'todo:automation.catchUp': 'Missed runs',
    'todo:automation.runOnce': 'Run once after resume',
    'todo:automation.catchAll': 'Run each missed occurrence',
    'todo:automation.skip': 'Skip',
    'todo:automation.sessionMode': 'Session',
    'todo:automation.isolated': 'New each run',
    'todo:automation.named': 'Continuous session',
    'todo:automation.model': 'Model configuration ID',
    'todo:automation.defaultModel': 'Use default model',
    'todo:automation.retries': 'Failure retries',
    'todo:automation.retryBackoff': 'Retry delay seconds',
    'todo:automation.timeout': 'Timeout seconds',
    'todo:automation.prompt': 'Task instructions',
    'todo:automation.timeInvalid': 'Enter a valid 24-hour time',
    'todo:automation.retry': 'Retry',
    'todo:automation.openSession': 'Open run conversation',
    'todo:automation.create': 'Create',
    'todo:automation.status.queued': 'Queued',
    'todo:automation.trigger.schedule': 'Scheduled',
    'settings:automation.action_type.agent_turn': 'Agent task',
    'common:actions.refresh': 'Refresh',
    'common:actions.close': 'Close',
    'common:actions.cancel': 'Cancel',
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

import { TodoAutomationWorkspace } from '../TodoAutomationWorkspace';

const automation = {
  id: 'auto_morning',
  version: 3,
  name: 'Morning review',
  schedule: { kind: 'daily', time: '20:00', timezone: 'Asia/Shanghai' },
  prompt: 'Review the due queue',
  enabled: true,
  action_type: 'notify',
  heartbeat: false,
  catch_up_policy: 'run_once',
  max_retries: 2,
  retry_backoff_seconds: 60,
  timeout_seconds: 600,
};

describe('TodoAutomationWorkspace', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => undefined);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'chat_v2_automation_summary') {
        return {
          enabledCount: 1,
          runningCount: 0,
          failedCount: 0,
          nextRunAt: '2026-07-15T12:00:00Z',
          backgroundEnabled: true,
        };
      }
      if (command === 'chat_v2_automation_runs') {
        return {
          runs: [{
            id: 'run_1',
            automation_id: automation.id,
            status: 'queued',
            trigger_type: 'schedule',
            scheduled_for: '2026-07-14T12:00:00Z',
            attempt: 1,
            max_attempts: 3,
            delivered: [],
          }],
        };
      }
      if (command === 'chat_v2_automation_list') {
        return { count: 1, max: 20, automations: [automation] };
      }
      return { success: true };
    });
  });

  it('shows the owning task and localized queued history state', async () => {
    render(<TodoAutomationWorkspace />);

    fireEvent.click(await screen.findByRole('button', { name: /Run history/ }));

    expect(await screen.findByText('Morning review')).toBeInTheDocument();
    expect(screen.getByText('Queued')).toHaveClass('text-primary');
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith('chat_v2_automation_runs', {
      automationId: undefined,
      limit: 50,
    });
  });

  it('rejects a cleared daily time before invoking the backend', async () => {
    render(<TodoAutomationWorkspace />);
    fireEvent.click(await screen.findByRole('button', { name: 'New task' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Synthetic reminder' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Task instructions'), { target: { value: 'Synthetic QA only' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid 24-hour time');
    expect(invokeMock).not.toHaveBeenCalledWith('chat_v2_automation_create', expect.anything());
  });

  it('creates a notification task without Agent-only fields', async () => {
    render(<TodoAutomationWorkspace />);
    fireEvent.click(await screen.findByRole('button', { name: 'New task' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Synthetic reminder' } });
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'notify' } });
    fireEvent.change(screen.getByLabelText('Task instructions'), { target: { value: 'Synthetic QA only' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('chat_v2_automation_create', {
        request: expect.objectContaining({
          name: 'Synthetic reminder',
          actionType: 'notify',
          prompt: 'Synthetic QA only',
          enabled: true,
        }),
      });
    });
    const createCall = invokeMock.mock.calls.find(([command]) => command === 'chat_v2_automation_create');
    expect(createCall?.[1]?.request).not.toHaveProperty('agentPrompt');
    expect(createCall?.[1]?.request).not.toHaveProperty('sessionMode');
  });
});

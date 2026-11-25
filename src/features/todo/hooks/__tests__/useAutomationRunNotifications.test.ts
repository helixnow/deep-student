import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listenMock, showGlobalNotificationMock, workbenchLaunchMock } = vi.hoisted(() => ({
  listenMock: vi.fn(),
  showGlobalNotificationMock: vi.fn(),
  workbenchLaunchMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: (...args: unknown[]) => showGlobalNotificationMock(...args),
}));

vi.mock('@/features/workbench/core/workbenchBus', () => ({
  workbenchBus: {
    launch: (...args: unknown[]) => workbenchLaunchMock(...args),
  },
}));

vi.mock('react-i18next', () => {
  const dict: Record<string, string> = {
    'automation.title': 'Scheduled Tasks',
    'automation.runCompletedTitle': '{{name}} completed',
    'automation.runFailedTitle': '{{name}} failed',
    'automation.runCompletedFallback': 'The scheduled task completed.',
    'automation.runFailedFallback': 'The scheduled task failed.',
    'automation.runFailedReason': 'Reason: {{reason}}',
    'automation.viewSession': 'View conversation',
    'automation.status.retrying': 'Waiting to retry',
  };
  return {
    initReactI18next: { type: '3rdParty' as const, init: () => undefined },
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) => {
        const template = dict[key] ?? String(options?.defaultValue ?? key);
        return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(options?.[k] ?? ''));
      },
      i18n: { language: 'en-US', resolvedLanguage: 'en-US' },
    }),
  };
});

import { useAutomationRunNotifications } from '../useAutomationRunNotifications';
import type { AutomationRunCompletedPayload } from '@/features/settings/components/automationSettingsApi';

describe('useAutomationRunNotifications', () => {
  let handler: ((event: { payload: AutomationRunCompletedPayload }) => void) | null = null;

  beforeEach(() => {
    handler = null;
    showGlobalNotificationMock.mockReset();
    workbenchLaunchMock.mockReset();
    listenMock.mockReset();
    listenMock.mockImplementation(async (_event: string, cb: (e: { payload: AutomationRunCompletedPayload }) => void) => {
      handler = cb;
      return () => undefined;
    });
  });

  it('shows an error toast with reason for spawn_error including heartbeat runs', async () => {
    renderHook(() => useAutomationRunNotifications());
    await vi.waitFor(() => expect(handler).not.toBeNull());

    handler!({
      payload: {
        automationId: 'auto_heartbeat_default',
        automationName: 'Study Heartbeat Check',
        runId: 'run_spawn_1',
        attempt: 1,
        status: 'spawn_error',
        summary: 'No enabled model configured',
        heartbeat: true,
        osNotificationDelivered: false,
      },
    });

    expect(showGlobalNotificationMock).toHaveBeenCalledWith(
      'error',
      'Reason: No enabled model configured',
      'Study Heartbeat Check failed',
      undefined,
    );
  });

  it('shows a warning toast with failure reason when a non-heartbeat run enters retrying', async () => {
    renderHook(() => useAutomationRunNotifications());
    await vi.waitFor(() => expect(handler).not.toBeNull());

    handler!({
      payload: {
        automationId: 'auto_morning',
        automationName: 'Morning review',
        runId: 'run_retry_1',
        attempt: 1,
        status: 'retrying',
        summary: 'HTTP 503 Service Unavailable',
        heartbeat: false,
        osNotificationDelivered: false,
      },
    });

    expect(showGlobalNotificationMock).toHaveBeenCalledWith(
      'warning',
      'Reason: HTTP 503 Service Unavailable',
      'Morning review · Waiting to retry',
      undefined,
    );
  });

  it('silences heartbeat_ok and heartbeat retrying events', async () => {
    renderHook(() => useAutomationRunNotifications());
    await vi.waitFor(() => expect(handler).not.toBeNull());

    handler!({
      payload: {
        automationId: 'auto_heartbeat_default',
        automationName: 'Study Heartbeat Check',
        runId: 'run_hb_ok',
        attempt: 1,
        status: 'heartbeat_ok',
        summary: 'HEARTBEAT_OK',
        heartbeat: true,
        osNotificationDelivered: false,
      },
    });
    handler!({
      payload: {
        automationId: 'auto_heartbeat_default',
        automationName: 'Study Heartbeat Check',
        runId: 'run_hb_retry',
        attempt: 1,
        status: 'retrying',
        summary: 'temporary glitch',
        heartbeat: true,
        osNotificationDelivered: false,
      },
    });

    expect(showGlobalNotificationMock).not.toHaveBeenCalled();
  });

  it('suppresses duplicate in-app toast when backend already delivered OS notification', async () => {
    renderHook(() => useAutomationRunNotifications());
    await vi.waitFor(() => expect(handler).not.toBeNull());

    handler!({
      payload: {
        automationId: 'auto_morning',
        automationName: 'Morning review',
        runId: 'run_os_1',
        attempt: 1,
        status: 'success',
        summary: 'All done',
        heartbeat: false,
        osNotificationDelivered: true,
      },
    });

    expect(showGlobalNotificationMock).not.toHaveBeenCalled();
  });
});

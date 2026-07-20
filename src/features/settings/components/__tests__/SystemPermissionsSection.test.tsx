import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SystemPermissionsSection } from '../SystemPermissionsSection';

const permissionMocks = vi.hoisted(() => ({
  getSystemAuthorizationSnapshot: vi.fn(),
  openSystemPermissionSettings: vi.fn(),
  requestMicrophoneAuthorization: vi.fn(),
  requestNotificationAuthorization: vi.fn(),
}));

const platformMocks = vi.hoisted(() => ({
  isMacOS: vi.fn(() => true),
  isMobilePlatform: vi.fn(() => false),
  isWindows: vi.fn(() => false),
}));

const runtimeMocks = vi.hoisted(() => ({
  isTauriRuntime: vi.fn(() => true),
}));

const pendingSettingsMocks = vi.hoisted(() => ({
  setPendingSettingsTab: vi.fn(),
}));

const uiNotificationMocks = vi.hoisted(() => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/features/settings/systemPermissions', () => permissionMocks);
vi.mock('@/utils/platform', () => platformMocks);
vi.mock('@/api/tauriClient', () => runtimeMocks);
vi.mock('@/utils/pendingSettingsTab', () => pendingSettingsMocks);
vi.mock('@/components/UnifiedNotification', () => uiNotificationMocks);

describe('SystemPermissionsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platformMocks.isMacOS.mockReturnValue(true);
    platformMocks.isMobilePlatform.mockReturnValue(false);
    platformMocks.isWindows.mockReturnValue(false);
    runtimeMocks.isTauriRuntime.mockReturnValue(true);
    permissionMocks.getSystemAuthorizationSnapshot.mockResolvedValue({
      notifications: 'not_requested',
      microphone: 'denied',
    });
    permissionMocks.requestNotificationAuthorization.mockResolvedValue('denied');
    permissionMocks.requestMicrophoneAuthorization.mockResolvedValue('granted');
    permissionMocks.openSystemPermissionSettings.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('requests a new permission and opens macOS settings after denial', async () => {
    render(<SystemPermissionsSection />);

    await screen.findByText('system_authorization.status.not_requested');
    fireEvent.click(screen.getByRole('button', { name: 'system_authorization.request' }));

    await waitFor(() => {
      expect(permissionMocks.requestNotificationAuthorization).toHaveBeenCalledTimes(1);
      expect(screen.getAllByText('system_authorization.status.denied')).toHaveLength(2);
    });

    fireEvent.click(screen.getAllByRole('button', {
      name: 'system_authorization.open_settings',
    })[0]);
    expect(permissionMocks.openSystemPermissionSettings).toHaveBeenCalledWith('notifications');
  });

  it('refreshes permission state when the app regains focus', async () => {
    render(<SystemPermissionsSection />);
    await screen.findByText('system_authorization.status.not_requested');

    permissionMocks.getSystemAuthorizationSnapshot.mockResolvedValue({
      notifications: 'granted',
      microphone: 'granted',
    });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => {
      expect(permissionMocks.getSystemAuthorizationSnapshot).toHaveBeenCalledTimes(2);
      expect(screen.getAllByText('system_authorization.status.granted')).toHaveLength(2);
    });
  });

  it('opens Windows Settings for permissions that were denied', async () => {
    platformMocks.isMacOS.mockReturnValue(false);
    platformMocks.isWindows.mockReturnValue(true);
    render(<SystemPermissionsSection />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', {
        name: 'system_authorization.open_settings',
      })).toHaveLength(1);
    });
    fireEvent.click(screen.getByRole('button', {
      name: 'system_authorization.open_settings',
    }));

    expect(permissionMocks.openSystemPermissionSettings).toHaveBeenCalledWith('microphone');
  });

  it('does not offer an ineffective denied-state action on Linux', async () => {
    platformMocks.isMacOS.mockReturnValue(false);
    platformMocks.isWindows.mockReturnValue(false);
    render(<SystemPermissionsSection />);

    await screen.findByText('system_authorization.status.not_requested');

    expect(screen.queryByRole('button', {
      name: 'system_authorization.open_settings',
    })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {
      name: 'system_authorization.retry',
    })).not.toBeInTheDocument();
    expect(permissionMocks.requestMicrophoneAuthorization).not.toHaveBeenCalled();
    expect(permissionMocks.openSystemPermissionSettings).not.toHaveBeenCalled();
  });

  it('does not refresh behind an active operating-system permission prompt', async () => {
    let resolveRequest: ((status: string) => void) | undefined;
    permissionMocks.requestNotificationAuthorization.mockReturnValue(new Promise((resolve) => {
      resolveRequest = resolve;
    }));
    render(<SystemPermissionsSection />);
    await screen.findByText('system_authorization.status.not_requested');

    fireEvent.click(screen.getByRole('button', { name: 'system_authorization.request' }));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(permissionMocks.getSystemAuthorizationSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRequest?.('granted');
    });
    expect(await screen.findByText('system_authorization.status.granted')).toBeInTheDocument();
  });

  it('does not downgrade an explicit grant when a later query is ambiguous', async () => {
    permissionMocks.requestNotificationAuthorization.mockResolvedValue('granted');
    render(<SystemPermissionsSection />);
    await screen.findByText('system_authorization.status.not_requested');

    fireEvent.click(screen.getByRole('button', { name: 'system_authorization.request' }));
    await screen.findByText('system_authorization.status.granted');

    permissionMocks.getSystemAuthorizationSnapshot.mockResolvedValue({
      notifications: 'not_requested',
      microphone: 'unknown',
    });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => {
      expect(permissionMocks.getSystemAuthorizationSnapshot).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByText('system_authorization.status.granted')).toBeInTheDocument();
  });

  it('hides authorization actions while the initial status is checking', () => {
    permissionMocks.getSystemAuthorizationSnapshot.mockReturnValue(new Promise(() => {}));
    render(<SystemPermissionsSection />);

    expect(screen.getAllByText('system_authorization.status.checking')).toHaveLength(2);
    expect(screen.queryByRole('button', {
      name: 'system_authorization.request',
    })).not.toBeInTheDocument();
  });

  it('maps unavailable permissions to a refresh action', async () => {
    permissionMocks.getSystemAuthorizationSnapshot.mockResolvedValue({
      notifications: 'unavailable',
      microphone: 'granted',
    });
    render(<SystemPermissionsSection />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', {
        name: 'system_authorization.refresh',
      })).toHaveLength(2);
    });
    const refreshButtons = screen.getAllByRole('button', {
      name: 'system_authorization.refresh',
    });
    fireEvent.click(refreshButtons[0]);
    await waitFor(() => {
      expect(permissionMocks.getSystemAuthorizationSnapshot).toHaveBeenCalledTimes(2);
    });
  });

  it('reports a native settings launch failure', async () => {
    permissionMocks.openSystemPermissionSettings.mockRejectedValue(new Error('launch failed'));
    render(<SystemPermissionsSection />);
    await screen.findByText('system_authorization.status.denied');

    fireEvent.click(screen.getByRole('button', {
      name: 'system_authorization.open_settings',
    }));
    await waitFor(() => {
      expect(uiNotificationMocks.showGlobalNotification).toHaveBeenCalledWith(
        'error',
        'launch failed',
      );
    });
  });

  it('navigates to the existing tool-permissions section for folder access', async () => {
    render(<SystemPermissionsSection />);
    await screen.findByText('system_authorization.files.status');
    const dispatchEvent = vi.spyOn(window, 'dispatchEvent');

    fireEvent.click(screen.getByRole('button', {
      name: 'system_authorization.files.manage',
    }));

    expect(pendingSettingsMocks.setPendingSettingsTab).toHaveBeenCalledWith('mcp');
    const navigationEvent = dispatchEvent.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === 'SETTINGS_NAVIGATE_TAB') as CustomEvent | undefined;
    expect(navigationEvent?.detail).toEqual({ tab: 'mcp' });
  });

  it('does not render the desktop permission center on mobile', () => {
    platformMocks.isMobilePlatform.mockReturnValue(true);
    render(<SystemPermissionsSection />);

    expect(screen.queryByText('system_authorization.title')).not.toBeInTheDocument();
    expect(permissionMocks.getSystemAuthorizationSnapshot).not.toHaveBeenCalled();
  });

  it('does not render native permission controls in a plain browser', () => {
    runtimeMocks.isTauriRuntime.mockReturnValue(false);
    render(<SystemPermissionsSection />);

    expect(screen.queryByText('system_authorization.title')).not.toBeInTheDocument();
    expect(permissionMocks.getSystemAuthorizationSnapshot).not.toHaveBeenCalled();
  });
});

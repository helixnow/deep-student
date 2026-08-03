import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getSystemNotificationPermissionState } from '../systemNotification';

const notificationPluginMocks = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-notification', () => notificationPluginMocks);

function stubNotificationPermission(permission: NotificationPermission): void {
  vi.stubGlobal('Notification', { permission });
}

describe('getSystemNotificationPermissionState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves the WebView denied state instead of reporting it as unrequested', async () => {
    stubNotificationPermission('denied');

    await expect(getSystemNotificationPermissionState()).resolves.toBe('denied');
    expect(notificationPluginMocks.isPermissionGranted).not.toHaveBeenCalled();
  });

  it('uses the plugin when the WebView permission is still at its default', async () => {
    stubNotificationPermission('default');
    notificationPluginMocks.isPermissionGranted.mockResolvedValue(false);

    await expect(getSystemNotificationPermissionState()).resolves.toBe('prompt');
    expect(notificationPluginMocks.isPermissionGranted).toHaveBeenCalledTimes(1);
  });
});

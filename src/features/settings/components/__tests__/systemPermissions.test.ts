import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getMicrophoneAuthorizationStatus,
  getNotificationAuthorizationStatus,
  openSystemPermissionSettings,
  requestMicrophoneAuthorization,
  requestNotificationAuthorization,
} from '../../systemPermissions';

const notificationMocks = vi.hoisted(() => ({
  getSystemNotificationPermissionState: vi.fn(),
  requestSystemNotificationPermission: vi.fn(),
}));

const voiceMocks = vi.hoisted(() => ({
  detectVoiceRecordingSupport: vi.fn(),
  requestVoiceRecordingPermission: vi.fn(),
}));

const tauriMocks = vi.hoisted(() => ({
  tauriInvoke: vi.fn(),
}));

vi.mock('@/utils/systemNotification', () => notificationMocks);
vi.mock('@/voice-input/support', () => voiceMocks);
vi.mock('@/api/tauriClient', () => tauriMocks);

describe('systemPermissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes notification plugin states', async () => {
    notificationMocks.getSystemNotificationPermissionState.mockResolvedValue('prompt');
    notificationMocks.requestSystemNotificationPermission.mockResolvedValue('denied');

    await expect(getNotificationAuthorizationStatus()).resolves.toBe('not_requested');
    await expect(requestNotificationAuthorization()).resolves.toBe('denied');
  });

  it('reports microphone capability without claiming an unknown grant', async () => {
    voiceMocks.detectVoiceRecordingSupport.mockResolvedValue({
      permissionState: 'unsupported',
      hasGetUserMedia: true,
    });
    await expect(getMicrophoneAuthorizationStatus()).resolves.toBe('unknown');

    voiceMocks.detectVoiceRecordingSupport.mockResolvedValue({
      permissionState: 'unsupported',
      hasGetUserMedia: false,
    });
    await expect(getMicrophoneAuthorizationStatus()).resolves.toBe('unavailable');

    voiceMocks.detectVoiceRecordingSupport.mockRejectedValue(new Error('runtime failure'));
    await expect(getMicrophoneAuthorizationStatus()).resolves.toBe('unavailable');
  });

  it('treats a successful microphone capture probe as an explicit grant', async () => {
    voiceMocks.requestVoiceRecordingPermission.mockResolvedValue({});
    await expect(requestMicrophoneAuthorization()).resolves.toBe('granted');

    voiceMocks.requestVoiceRecordingPermission.mockRejectedValue(new Error('permission-denied'));
    await expect(requestMicrophoneAuthorization()).resolves.toBe('denied');

    for (const code of [
      'missing-get-user-media',
      'missing-recorder-backend',
      'insecure-context',
    ]) {
      voiceMocks.requestVoiceRecordingPermission.mockRejectedValue(new Error(code));
      await expect(requestMicrophoneAuthorization()).resolves.toBe('unavailable');
    }

    voiceMocks.requestVoiceRecordingPermission.mockRejectedValue(new Error('microphone-busy'));
    await expect(requestMicrophoneAuthorization()).resolves.toBe('unknown');
  });

  it('uses the typed IPC client with a closed permission target', async () => {
    tauriMocks.tauriInvoke.mockResolvedValue(undefined);

    await openSystemPermissionSettings('microphone');

    expect(tauriMocks.tauriInvoke).toHaveBeenCalledWith(
      'open_system_permission_settings',
      { permission: 'microphone' },
    );
  });
});

import { tauriInvoke } from '@/api/tauriClient';
import {
  getSystemNotificationPermissionState,
  requestSystemNotificationPermission,
} from '@/utils/systemNotification';
import {
  detectVoiceRecordingSupport,
  requestVoiceRecordingPermission,
} from '@/voice-input/support';

export type SystemAuthorizationStatus =
  | 'checking'
  | 'granted'
  | 'not_requested'
  | 'denied'
  | 'unavailable'
  | 'unknown';

export type SystemPermissionSettingsTarget = 'notifications' | 'microphone';

export interface SystemAuthorizationSnapshot {
  notifications: SystemAuthorizationStatus;
  microphone: SystemAuthorizationStatus;
}

function mapNotificationStatus(
  status: Awaited<ReturnType<typeof getSystemNotificationPermissionState>>,
): SystemAuthorizationStatus {
  if (status === 'granted') return 'granted';
  if (status === 'denied') return 'denied';
  if (status === 'unavailable') return 'unavailable';
  return 'not_requested';
}

export async function getNotificationAuthorizationStatus(): Promise<SystemAuthorizationStatus> {
  return mapNotificationStatus(await getSystemNotificationPermissionState());
}

export async function requestNotificationAuthorization(): Promise<SystemAuthorizationStatus> {
  return mapNotificationStatus(await requestSystemNotificationPermission());
}

export async function getMicrophoneAuthorizationStatus(): Promise<SystemAuthorizationStatus> {
  try {
    const support = await detectVoiceRecordingSupport();
    switch (support.permissionState) {
      case 'granted':
        return 'granted';
      case 'prompt':
        return 'not_requested';
      case 'denied':
        return 'denied';
      case 'unsupported':
        return support.hasGetUserMedia ? 'unknown' : 'unavailable';
      default:
        return 'unknown';
    }
  } catch {
    return 'unavailable';
  }
}

export async function requestMicrophoneAuthorization(): Promise<SystemAuthorizationStatus> {
  try {
    await requestVoiceRecordingPermission();
    // getUserMedia 成功即代表本次已获授权，即使 WebView 不支持 Permissions API。
    return 'granted';
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    if (code === 'permission-denied') return 'denied';
    if (
      code === 'missing-get-user-media'
      || code === 'missing-recorder-backend'
      || code === 'insecure-context'
    ) {
      return 'unavailable';
    }
    return 'unknown';
  }
}

export async function getSystemAuthorizationSnapshot(): Promise<SystemAuthorizationSnapshot> {
  const [notifications, microphone] = await Promise.all([
    getNotificationAuthorizationStatus(),
    getMicrophoneAuthorizationStatus(),
  ]);
  return { notifications, microphone };
}

export async function openSystemPermissionSettings(
  permission: SystemPermissionSettingsTarget,
): Promise<void> {
  await tauriInvoke<void>('open_system_permission_settings', { permission });
}

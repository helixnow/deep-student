import { showGlobalNotification } from '@/components/UnifiedNotification';

export const DEFAULT_STREAM_RECONNECT_MAX = 5;

export interface StreamReconnectNotificationPayload {
  retryAttempt?: number;
  retryMax?: number;
}

const normalizePositiveInteger = (value: unknown, fallback: number): number => {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
};

export const formatStreamReconnectMessage = (
  payload: StreamReconnectNotificationPayload,
): string => {
  const attempt = normalizePositiveInteger(payload.retryAttempt, 1);
  const max = normalizePositiveInteger(payload.retryMax, DEFAULT_STREAM_RECONNECT_MAX);

  return `reconnect...(${attempt}/${max})`;
};

export const notifyStreamReconnect = (payload: StreamReconnectNotificationPayload): void => {
  showGlobalNotification('info', formatStreamReconnectMessage(payload), undefined, {
    borderTone: 'neutral',
  });
};

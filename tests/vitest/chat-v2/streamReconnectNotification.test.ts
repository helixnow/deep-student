import { describe, expect, it } from 'vitest';
import { formatStreamReconnectMessage } from '@/features/chat/adapters/streamReconnectNotification';

describe('stream reconnect notification', () => {
  it('formats retry progress with a default maximum of five attempts', () => {
    expect(formatStreamReconnectMessage({ retryAttempt: 1 })).toBe('reconnect...(1/5)');
  });

  it('uses the backend-provided retry maximum when present', () => {
    expect(formatStreamReconnectMessage({ retryAttempt: 3, retryMax: 7 })).toBe('reconnect...(3/7)');
  });
});

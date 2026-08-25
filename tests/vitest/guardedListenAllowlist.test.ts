import { describe, expect, it } from 'vitest';
import {
  GUARDED_LISTEN_EXACT_NON_CHAT_EVENTS,
  isWhitelistedNonChat,
} from '@/utils/guardedListen';
import { HPIAS_EVENT_CHANNEL } from '@/features/generative-ui/bridge/hpiasEventBridge';

describe('guardedListen non-chat allowlist', () => {
  it('allows the canonical HPIAS channel by exact name', () => {
    expect(GUARDED_LISTEN_EXACT_NON_CHAT_EVENTS).toContain(HPIAS_EVENT_CHANNEL);
    expect(isWhitelistedNonChat(HPIAS_EVENT_CHANNEL)).toBe(true);
  });

  it('does not broaden the HPIAS exception to lookalike channels', () => {
    expect(isWhitelistedNonChat('hpias_event_private')).toBe(false);
    expect(isWhitelistedNonChat('hpias-event')).toBe(false);
    expect(isWhitelistedNonChat('prefix_hpias_event')).toBe(false);
  });

  it('retains platform event prefixes and rejects unrelated events', () => {
    expect(isWhitelistedNonChat('tauri://drag-drop')).toBe(true);
    expect(isWhitelistedNonChat('window_resized')).toBe(true);
    expect(isWhitelistedNonChat('arbitrary_plugin_event')).toBe(false);
  });
});

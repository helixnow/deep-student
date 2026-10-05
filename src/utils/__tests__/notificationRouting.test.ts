import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ mobile: false, onAction: vi.fn(), unregister: vi.fn() }));

vi.mock('../platform', () => ({ isMobilePlatform: () => env.mobile }));
vi.mock('../shared', () => ({ isTauriRuntime: true }));
vi.mock('@tauri-apps/plugin-notification', () => ({ onAction: env.onAction }));

import {
  NOTIFICATION_CLICK_WINDOW_MS,
  extractNotificationTarget,
  initNotificationRouting,
  rememberNotificationTarget,
} from '../notificationRouting';

describe('notification routing', () => {
  let stop: (() => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    env.mobile = false;
    env.onAction.mockResolvedValue({ unregister: env.unregister });
  });
  afterEach(() => {
    stop?.();
    stop = null;
    vi.useRealTimers();
  });

  it('reads the target from both action payload shapes', () => {
    expect(extractNotificationTarget({ actionId: 'tap', notification: { extra: { target: 'review:cards' } } })).toBe('review:cards');
    expect(extractNotificationTarget({ extra: { target: 'review:notes' } })).toBe('review:notes');
    expect(extractNotificationTarget({ notification: { extra: {} } })).toBeNull();
    expect(extractNotificationTarget(null)).toBeNull();
  });

  it('on desktop treats the first return to the app shortly after the notification as its click', () => {
    vi.useFakeTimers();
    const handler = vi.fn();
    stop = initNotificationRouting(handler);

    rememberNotificationTarget('review:mistakes');
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('review:mistakes');

    // 之后的回前台不再跳转
    window.dispatchEvent(new Event('focus'));
    expect(handler).toHaveBeenCalledTimes(1);

    // 隔太久才回来：不是点通知回来的
    rememberNotificationTarget('review:cards');
    vi.advanceTimersByTime(NOTIFICATION_CLICK_WINDOW_MS + 1);
    window.dispatchEvent(new Event('focus'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('on mobile routes the tapped notification through the plugin action callback', async () => {
    env.mobile = true;
    const handler = vi.fn();
    stop = initNotificationRouting(handler);
    await vi.waitFor(() => expect(env.onAction).toHaveBeenCalled());

    const callback = env.onAction.mock.calls[0][0] as (payload: unknown) => void;
    callback({ actionId: 'tap', notification: { extra: { target: 'review:cards' } } });
    expect(handler).toHaveBeenCalledWith('review:cards');

    // 手机上回前台不靠推断（避免和点击回调重复跳转）
    rememberNotificationTarget('review:notes');
    window.dispatchEvent(new Event('focus'));
    expect(handler).toHaveBeenCalledTimes(1);

    stop();
    stop = null;
    await vi.waitFor(() => expect(env.unregister).toHaveBeenCalled());
  });
});

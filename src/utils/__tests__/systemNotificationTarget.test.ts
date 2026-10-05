import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  rememberNotificationTarget: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => 'granted'),
  sendNotification: mocks.sendNotification,
}));
vi.mock('../notificationRouting', () => ({ rememberNotificationTarget: mocks.rememberNotificationTarget }));
vi.mock('../shared', () => ({ isTauriRuntime: false }));
vi.mock('../settingsApi', () => ({ getSetting: vi.fn(), saveSetting: vi.fn() }));

import { sendSystemNotification } from '../systemNotification';

describe('sendSystemNotification target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem('system-notification-policy', 'always');
  });
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('carries the target in extra and remembers it when the app is in the background', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    await expect(sendSystemNotification('今日有 3 项待复习', '卡片 3 张', { target: 'review:cards' })).resolves.toBe(true);
    expect(mocks.sendNotification).toHaveBeenCalledWith({
      title: '今日有 3 项待复习',
      body: '卡片 3 张',
      extra: { target: 'review:cards' },
    });
    expect(mocks.rememberNotificationTarget).toHaveBeenCalledWith('review:cards');
  });

  it('does not guess a click when the app was already in front, and plain notifications stay plain', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    await sendSystemNotification('t', 'b', { target: 'review:notes' });
    expect(mocks.rememberNotificationTarget).not.toHaveBeenCalled();

    await sendSystemNotification('t', 'b');
    expect(mocks.sendNotification).toHaveBeenLastCalledWith({ title: 't', body: 'b' });
  });
});

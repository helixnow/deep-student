import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../shell/runtime.ts';
import { notificationPlugin } from '../shell/plugins/system.ts';

const ctx = {} as CommandContext;
const invoke = (options: unknown) => ({
  command: 'notify',
  json: { options },
  raw: null,
  headers: {},
});

describe('plugin:notification|notify', () => {
  it('returns null only after the native show call accepts the notification', () => {
    const show = vi.fn();
    const plugin = notificationPlugin({ isSupported: () => true, show });
    expect(plugin.notify!(invoke({ title: '自动化完成', body: 'done', id: 42, silent: true }), ctx)).toBeNull();
    expect(show).toHaveBeenCalledWith({
      id: '42',
      title: '自动化完成',
      body: 'done',
      silent: true,
    });
  });

  it('rejects when the platform has no notification API or show throws', () => {
    const unsupported = notificationPlugin({ isSupported: () => false, show: vi.fn() });
    expect(() => unsupported.notify!(invoke({ title: 't' }), ctx)).toThrow(
      '[electron-shell] notifications are not supported on this system',
    );

    const failing = notificationPlugin({
      isSupported: () => true,
      show: () => { throw new Error('no notification daemon'); },
    });
    expect(() => failing.notify!(invoke({ title: 't' }), ctx)).toThrow(
      '[electron-shell] notification failed: no notification daemon',
    );
  });

  it('keeps the desktop permission commands and Tauri argument errors', () => {
    const plugin = notificationPlugin({ isSupported: () => true, show: vi.fn() });
    expect(plugin.is_permission_granted!(invoke({}), ctx)).toBe(true);
    expect(plugin.request_permission!(invoke({}), ctx)).toBe('granted');
    expect(() => plugin.notify!({ command: 'notify', json: {}, raw: null, headers: {} }, ctx)).toThrow(
      'invalid args `options` for command `notify`: command notify missing required key options',
    );
  });
});

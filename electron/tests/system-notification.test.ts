import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../host/kernel/testing.ts';
import plugin from '../index.ts';
import {
  SYSTEM_NOTIFICATION_POLICY_KEY,
  type SystemNotificationService,
} from '../api.ts';

interface HarnessOptions {
  policy?: string | null;
  settingsThrows?: boolean;
  active?: boolean;
  activeError?: string;
  showError?: string;
}

async function harness(options: HarnessOptions = {}) {
  const host = await createTestHost({
    plugins: [plugin],
    provide: {
      settings: {
        get(key: string): string | null {
          if (options.settingsThrows === true) throw new Error('settings database is locked');
          return key === SYSTEM_NOTIFICATION_POLICY_KEY ? (options.policy ?? null) : null;
        },
      },
    },
    shell: (op) => {
      if (op === 'app.mainWindowActive') {
        if (options.activeError !== undefined) throw new Error(options.activeError);
        return options.active === true;
      }
      if (op === 'plugin:notification|notify') {
        if (options.showError !== undefined) throw new Error(options.showError);
        return null;
      }
      throw new Error(`unexpected shell op: ${op}`);
    },
  });
  return { host, service: host.ctx.systemNotification as SystemNotificationService };
}

const request = { id: 42, title: '自动化完成', body: 'done', suppressIfWindowActive: true };

describe('systemNotification Host service', () => {
  it('treats a missing, invalid or unreadable policy as background', async () => {
    for (const options of [{}, { policy: 'bogus' }, { settingsThrows: true }]) {
      const { host, service } = await harness(options);
      try {
        expect(service.policy()).toBe('background');
        expect(service.notificationsDisabled()).toBe(false);
      } finally { await host.dispose(); }
    }
  });

  it('suppresses notifications for the never policy without touching the native API', async () => {
    const { host, service } = await harness({ policy: 'never' });
    try {
      expect(service.notificationsDisabled()).toBe(true);
      await expect(service.notify(request)).resolves.toEqual({
        delivered: false, suppressed: 'policy', error: null,
      });
      expect(host.shellRequests).toEqual([]);
    } finally { await host.dispose(); }
  });

  it('delivers through plugin:notification|notify and only then reports success', async () => {
    const { host, service } = await harness({ policy: 'always', active: false });
    try {
      await expect(service.notify(request)).resolves.toEqual({
        delivered: true, suppressed: null, error: null,
      });
      expect(host.shellRequests.map((entry) => entry.op)).toEqual([
        'app.mainWindowActive',
        'plugin:notification|notify',
      ]);
      expect(host.shellRequests[0]?.args).toEqual({});
      expect(host.shellRequests[1]?.args).toEqual({
        options: { id: 42, title: '自动化完成', body: 'done' },
      });
    } finally { await host.dispose(); }
  });

  it('reports native delivery failures instead of pretending the notification arrived', async () => {
    const { host, service } = await harness({ policy: 'always', showError: 'no notification daemon' });
    try {
      await expect(service.notify({ title: 't', body: 'b' })).resolves.toEqual({
        delivered: false, suppressed: null, error: 'no notification daemon',
      });
    } finally { await host.dispose(); }
  });

  it('suppresses when the main window is focused, visible and not minimized', async () => {
    const { host, service } = await harness({ policy: 'background', active: true });
    try {
      await expect(service.notify(request)).resolves.toEqual({
        delivered: false, suppressed: 'window-active', error: null,
      });
      expect(host.shellRequests.map((entry) => entry.op)).toEqual(['app.mainWindowActive']);
    } finally { await host.dispose(); }
  });

  it('reports a failed window-activity query instead of guessing and delivering', async () => {
    const { host, service } = await harness({ policy: 'always', activeError: 'main window is gone' });
    try {
      await expect(service.notify(request)).resolves.toEqual({
        delivered: false,
        suppressed: null,
        error: 'failed to query main window activity: main window is gone',
      });
      expect(host.shellRequests.map((entry) => entry.op)).toEqual(['app.mainWindowActive']);
    } finally { await host.dispose(); }
  });

  it('does not query the window when suppression was not requested', async () => {
    const { host, service } = await harness({ policy: 'always', active: true });
    try {
      await expect(service.notify({ title: 't', body: 'b' })).resolves.toEqual({
        delivered: true, suppressed: null, error: null,
      });
      expect(host.shellRequests.map((entry) => entry.op)).toEqual(['plugin:notification|notify']);
    } finally { await host.dispose(); }
  });
});

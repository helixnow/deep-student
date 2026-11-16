import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import cryptoMobile from '../../crypto/mobile.ts';
import { createOpfsFiles, mobileRoots } from '../../files/opfs.ts';
import { createFakeOpfs } from '../../files/tests/__fixtures__/fake-opfs.ts';
import logMobile from '../../log/mobile.ts';
import pathsMobile from '../../paths/mobile.ts';
import secretsMobile from '../../secrets/mobile.ts';
import { Connection } from '../../storage/connection.ts';
import { PROFILES } from '../../storage/profiles.ts';
import settingsMobile from '../mobile.ts';
import { f3FeatureFlags } from '../../../plugins/browser/tests/support/f3-feature-flags.ts';

function createFakeStorage(conn: Connection) {
  return {
    locations: {
      baseDir: '/deep-student',
      activeDir: '/deep-student/slots/slotA',
      activeSlot: 'slotA',
      inactiveSlot: 'slotB',
      dataLocalDir: '/deep-student/local',
    },
    database: () => conn,
    pathOf: () => '/deep-student/slots/slotA/mistakes.db',
  };
}

describe('settings mobile plugin', () => {
  it('registers all declared commands and exposes the default backup directory (backup config / WebView settings live in dstu.platform.storage)', async () => {
    const conn = new Connection(':memory:', { label: 'settings-mobile-test', profile: PROFILES.plain });
    conn.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    const host = await createTestHost({
      app: { dataDir: '/deep-student', platform: 'linux', version: '0.20.1' },
    });
    try {
      const files = createOpfsFiles({ root: createFakeOpfs(), roots: mobileRoots('/deep-student') });
      host.ctx.reflect.provide('files', files);
      await host.install(cryptoMobile);
      await host.install(pathsMobile);
      await host.install(logMobile);
      await host.install(secretsMobile);
      host.ctx.reflect.provide('storage', createFakeStorage(conn) as never);
      host.ctx.reflect.provide('featureFlags', f3FeatureFlags as never);
      await host.install(settingsMobile);

      const coverage = host.coverage();
      expect(coverage.declaredNotRegistered).toEqual([]);
      expect(coverage.registeredNotDeclared).toEqual([]);

      expect(await host.invoke('get_default_backup_directory')).toBe('/deep-student/recovery/backups');
      expect(settingsMobile.meta.commands).not.toContain('get_backup_config');
      expect(settingsMobile.meta.commands).not.toContain('save_webview_settings');
    } finally {
      conn.close();
      await host.dispose();
    }
  });
});

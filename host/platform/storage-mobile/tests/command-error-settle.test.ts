import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createTestHost, unsettledCommandErrors } from '../../../kernel/testing.ts';
import { createWebCrypto } from '../../crypto/web.ts';
import { AppError } from '../../errors/api.ts';
import { createNodeFiles } from '../../files/index.ts';
import mobileStorage from '../index.ts';

it('settles every mobile storage invoke under SQLite and file failures with its declared error shape', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dstu-mobile-command-errors-'));
  const localFiles = createNodeFiles({ roots: [{ name: 'appData', path: dataDir }] });
  const files = { ...localFiles, writeAtomic: vi.fn(localFiles.writeAtomic), readText: vi.fn(localFiles.readText) };
  // An unavailable SQLite runtime puts the real mobile plugin in its recovery mode.
  // Files continue to work until errors are injected below, as they can on an actual device.
  const cannotOpen = () => { throw new Error('cannot open SQLite'); };
  const host = await createTestHost({
    app: { dataDir },
    provide: {
      crypto: createWebCrypto(),
      files,
      sqliteRuntime: { exists: () => false, open: cannotOpen, openMemory: cannotOpen },
    },
    plugins: [mobileStorage],
  });
  try {
    expect(await host.invoke('get_slot_directory', { slotName: 'slotA' })).toBe(join(dataDir, 'slots', 'slotA'));
    await host.invoke('save_webview_settings', { settings: { theme: 'dark' } });
    expect(await host.invoke('load_webview_settings')).toEqual({ exists: true, settings: { theme: 'dark' } });
    const config = { autoBackupEnabled: false, autoBackupIntervalHours: 12, slimBackup: false };
    await host.invoke('set_backup_config', { config });

    const writeFailed = new Error('disk full');
    files.writeAtomic.mockRejectedValue(writeFailed);
    files.readText.mockRejectedValue(new Error('file unreadable'));
    await expect(host.invoke('save_webview_settings', { settings: { theme: 'light' } }))
      .rejects.toEqual(AppError.file_system('disk full'));
    await expect(host.invoke('set_backup_config', { config: { ...config, autoBackupIntervalHours: 48 } }))
      .rejects.toEqual(AppError.file_system('disk full'));
    expect(await host.invoke('get_backup_config')).toMatchObject(config);
    await expect(host.invoke('load_webview_settings')).rejects.toEqual(AppError.file_system('file unreadable'));
    await expect(host.invoke('get_slot_directory', { slotName: 'invalid' }))
      .rejects.toEqual(AppError.validation('无效的插槽名称: invalid'));

    const args: Record<string, Record<string, unknown>> = {
      save_webview_settings: { settings: { theme: 'dark' } },
      set_backup_config: { config },
      // Cover rejection before scheduling background work that would outlive the fixture.
      data_governance_run_backup: { backupType: 'incremental' },
      data_governance_backup_tiered: { tiers: [] },
      data_governance_backup_and_export_zip: { outputPath: '', encryptionPassword: 'short' },
      data_governance_export_zip: { backupId: '..' },
      data_governance_import_zip: { zipPath: 'mobile-picker:', useStoredCloudEncryptionPassword: true },
      data_governance_restore_backup: { backupId: '..' },
    };
    expect(await unsettledCommandErrors(host, [mobileStorage], { args: command => args[command] })).toEqual([]);
  } finally {
    await host.dispose();
  }
});

import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../paths/index.ts';
import type { FileManagerPathsService } from '../../storage/api.ts';
import { getPersistentAppDataDir } from '../../storage/file-manager.ts';
import { createStorageService } from '../../storage/service.ts';
import log from '../../log/index.ts';
import secrets from '../../secrets/index.ts';
import settings from '../index.ts';
import backupConfig, { loadAutoBackupStatus } from '../backup-commands.ts';
import { expect, it } from 'vitest';

it('backup config commands persist camelCase JSON, defaults, directory picking; auto backup status is read internally', async () => {
  const selected = await mkdtemp(`${process.env.TMPDIR ?? '/tmp'}/dstu-pick-`);
  const host = await createTestHost({
    shell: (op) => {
      if (op !== 'dialog.open') throw new Error(`unexpected shell op ${op}`);
      return selected;
    },
  });
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  try {
    host.ctx.reflect.provide('paths', createPaths({
      dataDir: host.app.dataDir,
      platform: host.app.platform,
      env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir },
    }));
    host.ctx.reflect.provide('storage', storage);
    storage.database('mistakes').exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    await host.install(log);
    await host.install(secrets);
    await host.install(settings);
    await host.install(backupConfig);

    expect(await host.invoke('get_backup_config')).toEqual({
      backupDirectory: null, autoBackupEnabled: false, autoBackupIntervalHours: 24, maxBackupCount: 5, slimBackup: false,
    });
    expect(await host.invoke('set_backup_config', { config: { autoBackupEnabled: true, autoBackupIntervalHours: 48 } })).toBeNull();
    expect(await host.invoke('get_backup_config')).toEqual({
      backupDirectory: null, autoBackupEnabled: true, autoBackupIntervalHours: 48, maxBackupCount: null, slimBackup: false,
    });
    expect(host.ctx.settings.get('backup.config')).toBe('{"backupDirectory":null,"autoBackupEnabled":true,"autoBackupIntervalHours":48,"maxBackupCount":null,"slimBackup":false}');

    expect(await host.invoke('set_backup_config', { config: {
      backupDirectory: '/custom/path', autoBackupEnabled: true, autoBackupIntervalHours: 12,
      maxBackupCount: 10, slimBackup: true, backupTiers: ['core', 'vfs_full', { large_files: null }],
    } })).toBeNull();
    expect(await host.invoke('get_backup_config')).toEqual({
      backupDirectory: '/custom/path', autoBackupEnabled: true, autoBackupIntervalHours: 12,
      maxBackupCount: 10, slimBackup: true, backupTiers: ['core', 'important', 'large_assets'],
    });

    expect(await host.invoke('get_default_backup_directory')).toBe(`${host.app.dataDir}/recovery/backups`);
    expect(loadAutoBackupStatus(host.ctx.settings)).toEqual({
      lastAttemptAt: null, lastSuccessAt: null, lastError: null, nextDueAt: null, lastJobId: null,
    });
    host.ctx.settings.save('backup.auto_backup_status', '{"lastAttemptAt":"a","lastSuccessAt":null,"lastError":"e","nextDueAt":"d","lastJobId":"j"}');
    expect(loadAutoBackupStatus(host.ctx.settings)).toEqual({
      lastAttemptAt: 'a', lastSuccessAt: null, lastError: 'e', nextDueAt: 'd', lastJobId: 'j',
    });

    expect(await host.invoke('pick_backup_directory')).toBe(selected);
    expect(await host.invoke('get_backup_config')).toMatchObject({ backupDirectory: selected });
    expect(host.shellRequests.at(-1)).toMatchObject({ op: 'dialog.open', args: { options: { directory: true, title: '选择备份目录' }, __window: 'main' } });
    expect(await host.invoke('clear_backup_directory')).toBeNull();
    expect(await host.invoke('get_backup_config')).toMatchObject({ backupDirectory: null });

    host.ctx.settings.save('backup.config', '{');
    await expect(host.invoke('get_backup_config')).rejects.toMatchObject({ error_type: 'Unknown', message: expect.stringContaining('解析备份配置失败:') });
  } finally {
    storage.dispose();
    await host.dispose();
    await rm(selected, { recursive: true, force: true });
  }
});

// backup_config.rs:137-170 has only Some → save / None → Ok(None); blocking_pick_folder has no error channel and rfd's
// backend failure path logs `Failed to pick folder: {err}` then returns None (rfd-0.16.0 xdg_desktop_portal.rs:162-169).
it('pick_backup_directory resolves Ok(None) and logs when the dialog shell request fails', async () => {
  const host = await createTestHost({
    shell: (op) => {
      throw new Error(`smoke: shell unavailable (${op})`);
    },
  });
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  try {
    host.ctx.reflect.provide('paths', createPaths({
      dataDir: host.app.dataDir,
      platform: host.app.platform,
      env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir },
    }));
    host.ctx.reflect.provide('storage', storage);
    storage.database('mistakes').exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    await host.install(log);
    await host.install(secrets);
    await host.install(settings);
    await host.install(backupConfig);
    const errors: string[] = [];
    host.ctx.logger.exporter({ levels: { default: 4 }, export(event) {
      if (event.type === 'error') errors.push(String(event.args[0]));
    } });

    expect(await host.invoke('set_backup_config', { config: { backupDirectory: '/kept' } })).toBeNull();
    const before = host.ctx.settings.get('backup.config');

    await expect(host.invoke('pick_backup_directory')).resolves.toBeNull();
    expect(host.shellRequests).toMatchObject([{ op: 'dialog.open', args: { options: { directory: true, title: '选择备份目录' }, __window: 'main' } }]);
    expect(host.ctx.settings.get('backup.config')).toBe(before);
    expect(errors).toContain('Failed to pick folder: smoke: shell unavailable (dialog.open)');
  } finally {
    storage.dispose();
    await host.dispose();
  }
});

// src-tauri/src/lib.rs:2219-2223 registers exactly these five; backup_config.rs:231 get_auto_backup_status is defined but not
// in generate_handler!, so the Tauri ACL rejects it before any handler (kernel commandNotFound, host/kernel/errors.ts:36).
it('backup-config plugin registers only the five commands in Rust generate_handler', async () => {
  const host = await createTestHost({ shell: () => null });
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  try {
    host.ctx.reflect.provide('paths', createPaths({
      dataDir: host.app.dataDir,
      platform: host.app.platform,
      env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir },
    }));
    host.ctx.reflect.provide('storage', storage);
    storage.database('mistakes').exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    await host.install(log);
    await host.install(secrets);
    await host.install(settings);
    await host.install(backupConfig);

    expect(backupConfig.meta.commands).toEqual([
      'get_backup_config', 'set_backup_config', 'pick_backup_directory', 'clear_backup_directory', 'get_default_backup_directory',
    ]);
    expect(await host.invoke('get_backup_config')).toMatchObject({ autoBackupIntervalHours: 24 });
    expect(await host.invoke('set_backup_config', { config: {} })).toBeNull();
    expect(await host.invoke('pick_backup_directory')).toBeNull();
    expect(await host.invoke('clear_backup_directory')).toBeNull();
    expect(await host.invoke('get_default_backup_directory')).toBe(`${host.app.dataDir}/recovery/backups`);

    host.ctx.settings.save('backup.auto_backup_status', '{"lastJobId":"j"}');
    await expect(host.invoke('get_auto_backup_status')).rejects.toBe('get_auto_backup_status not allowed. Command not found');
  } finally {
    storage.dispose();
    await host.dispose();
  }
});

const rootIgnoresModes = process.getuid?.() === 0 || process.platform === 'win32';

// backup_config.rs:185 `get_default_backup_directory` = `default_recovery_backup_dir(file_manager.get_writable_app_data_dir())`:
// an unwritable active slot falls back to data_dir()/DeepStudent or temp, a directory backups are never written to.
it.skipIf(rootIgnoresModes)(
  'RF-W08-default-backup-dir-no-relocation: get_default_backup_directory derives from the persistent active slot and fails instead of relocating',
  async () => {
    const calls: string[] = [];
    let slot = '';
    const fileManagerPaths: FileManagerPathsService = {
      getPersistentAppDataDir: () => { calls.push('persistent'); return getPersistentAppDataDir(slot); },
      getTempAppDataDir: () => { throw new Error('getTempAppDataDir must not back the backup root'); },
      getWritableAppDataDir: () => { throw new Error('getWritableAppDataDir must not back the backup root'); },
      resolveImagePath: () => { throw new Error('resolveImagePath is not used'); },
    };
    const host = await createTestHost({ shell: () => null, provide: { fileManagerPaths } });
    const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
    slot = join(host.app.dataDir, 'slots', 'slotA');
    mkdirSync(slot, { recursive: true });
    const paths = createPaths({
      dataDir: host.app.dataDir,
      platform: host.app.platform,
      env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir },
    });
    try {
      host.ctx.reflect.provide('paths', paths);
      host.ctx.reflect.provide('storage', storage);
      storage.database('mistakes').exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
      await host.install(log);
      await host.install(secrets);
      await host.install(settings);
      await host.install(backupConfig);

      expect(await host.invoke('get_default_backup_directory')).toBe(join(host.app.dataDir, 'recovery', 'backups'));
      chmodSync(slot, 0o555);
      try {
        await expect(host.invoke('get_default_backup_directory')).rejects.toMatchObject({
          error_type: 'FileSystem', message: expect.stringContaining(`持久数据目录不可用（目录不可写）: ${slot} (`),
        });
      } finally {
        chmodSync(slot, 0o755);
      }
      expect(calls).toEqual(['persistent', 'persistent']);
      expect(existsSync(join(paths.os.data, 'DeepStudent'))).toBe(false);
    } finally {
      storage.dispose();
      await host.dispose();
    }
  },
);

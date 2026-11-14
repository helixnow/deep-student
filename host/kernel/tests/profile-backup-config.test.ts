import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { CapabilityAcl } from '../acl.ts';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../profile.ts';
import { createTestHost, type TestHost } from '../testing.ts';
import { PluginAdmin } from '../plugin-admin.ts';
import { UserProfileStore } from '../profile-store.ts';

// lib.rs:2219-2223: the production profile must reach these exact five handlers.
it('WP-128 official profile routes backup configuration through real settings and the shell boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dstu-profile-backup-'));
  vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  let host: TestHost | undefined;
  let selected: string | null = join(root, 'chosen-backups');
  try {
    host = await createTestHost({
      app: { dataDir: join(root, 'app'), platform: 'linux' },
      acl: CapabilityAcl.fromDirectory('linux'),
      shell(op) {
        expect(op).toBe('dialog.open');
        return selected;
      },
    });
    // Match the production managed bootstrap: installer is scoped per builtin, not a root service.
    new PluginAdmin({ runtime: host.runtime, official: OFFICIAL_PROFILE_PATH,
      store: new UserProfileStore(join(host.app.dataDir, 'plugins/user.profile.json'), OFFICIAL_PROFILE_PATH) }).register();
    const loaded = await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
    const ids = loaded.installed.map(entry => entry.id);
    expect(loaded.degraded).toEqual([]);
    expect(ids).toHaveLength(43); // The official plugin-workshop is now part of the desktop profile.
    expect(ids).toContain('dstu.plugin-workshop');
    expect(ids).toEqual(expect.arrayContaining(['dstu.platform.crypto', 'dstu.platform.files', 'dstu.platform.http']));
    expect(ids).toContain('dstu.platform.backup-config');
    expect(ids.indexOf('dstu.sync-startup')).toBeLessThan(ids.indexOf('dstu.platform.storage'));
    for (const dependency of ['dstu.platform.paths', 'dstu.platform.settings']) {
      expect(ids.indexOf(dependency)).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf(dependency)).toBeLessThan(ids.indexOf('dstu.platform.backup-config'));
    }
    const commands = ['get_backup_config', 'set_backup_config', 'pick_backup_directory', 'clear_backup_directory', 'get_default_backup_directory'];
    expect(loaded.installed.find(entry => entry.id === 'dstu.platform.backup-config')?.plugin.meta.commands).toEqual(commands);
    for (const command of commands) expect(host.runtime.commands.has(command), command).toBe(true);
    expect(host.runtime.commands.has('get_auto_backup_status')).toBe(false);
    await expect(host.invoke('get_auto_backup_status')).rejects.toBe('get_auto_backup_status not allowed. Command not found');

    await expect(host.invoke('get_backup_config')).resolves.toEqual({
      backupDirectory: null, autoBackupEnabled: false, autoBackupIntervalHours: 24, maxBackupCount: 5, slimBackup: false,
    });
    const config = {
      backupDirectory: join(root, 'configured-backups'), autoBackupEnabled: true,
      autoBackupIntervalHours: 48, maxBackupCount: 7, slimBackup: true, backupTiers: ['core', 'important'],
    };
    await expect(host.invoke('set_backup_config', { config })).resolves.toBeNull();
    await expect(host.invoke('get_backup_config')).resolves.toEqual(config);
    expect(host.ctx.settings.get('backup.config')).toBe(JSON.stringify(config));
    // Independent SQLite connection observes the committed value through the owner's API.
    const connection = host.ctx.storage.openFile(host.ctx.storage.pathOf('mistakes'), { mustExist: true });
    try {
      expect(host.ctx.settings.getWithConn(connection, 'backup.config')).toBe(JSON.stringify(config));
    } finally {
      host.ctx.storage.close(connection);
    }

    await expect(host.invoke('get_default_backup_directory')).resolves.toBe(join(host.app.dataDir, 'recovery', 'backups'));
    await expect(host.invoke('pick_backup_directory')).resolves.toBe(selected);
    expect(host.shellRequests).toHaveLength(1);
    expect(host.shellRequests[0]).toMatchObject({
      op: 'dialog.open', args: { options: { directory: true, title: '选择备份目录' }, __window: 'main' },
    });
    const picked = { ...config, backupDirectory: selected };
    await expect(host.invoke('get_backup_config')).resolves.toEqual(picked);
    expect(host.ctx.settings.get('backup.config')).toBe(JSON.stringify(picked));
    selected = null;
    await expect(host.invoke('pick_backup_directory')).resolves.toBeNull();
    expect(host.shellRequests).toHaveLength(2);
    expect(host.ctx.settings.get('backup.config')).toBe(JSON.stringify(picked));
    await expect(host.invoke('clear_backup_directory')).resolves.toBeNull();
    await expect(host.invoke('get_backup_config')).resolves.toEqual({ ...config, backupDirectory: null });
    expect(host.ctx.settings.get('backup.config')).toBe(JSON.stringify({ ...config, backupDirectory: null }));

    await host.unload('dstu.platform.backup-config');
    for (const command of commands) expect(host.runtime.commands.has(command), command).toBe(false);
    expect(host.ctx.settings.get('backup.config')).toBe(JSON.stringify({ ...config, backupDirectory: null }));
    expect(host.runtime.commands.has('get_auto_backup_status')).toBe(false);
  } finally {
    try { await host?.dispose(); }
    finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  }
}, 240_000);

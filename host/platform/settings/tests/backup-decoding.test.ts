import { afterEach, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../storage/service.ts';
import { createPaths } from '../../paths/index.ts';
import log from '../../log/index.ts';
import secrets from '../../secrets/index.ts';
import settings from '../index.ts';
import backupConfig, { loadAutoBackupStatus } from '../backup-commands.ts';
import { BackupConfigError } from '../backup-config.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function statusError(host: TestHost): unknown {
  try {
    loadAutoBackupStatus(host.ctx.settings);
  } catch (error) {
    return error instanceof BackupConfigError ? error.appError : error;
  }
  throw new Error('AutoBackupStatus::load unexpectedly succeeded');
}

async function setup(): Promise<TestHost> {
  const host = await createTestHost();
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  cleanups.push(async () => { await host.dispose(); storage.dispose(); });
  host.ctx.provide('paths', createPaths({ dataDir: host.app.dataDir, platform: host.app.platform,
    env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir } }));
  host.ctx.provide('storage', storage);
  storage.database('mistakes').exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
  await host.install(log);
  await host.install(secrets);
  await host.install(settings);
  await host.install(backupConfig);
  return host;
}

// BackupConfig::load -> serde_json::from_str, backup_config.rs:28-52,74-89.
// #[serde(default)] applies to absent bool fields, never to explicit null.
it('F4-V2-01 persisted null bool is an AppError and clear does not overwrite the invalid config', async () => {
  const host = await setup();
  for (const field of ['autoBackupEnabled', 'slimBackup']) {
    const raw = JSON.stringify({ [field]: null, backupDirectory: '/keep' });
    host.ctx.settings.save('backup.config', raw);
    for (const command of ['get_backup_config', 'clear_backup_directory']) {
      await expect(host.invoke(command)).rejects.toMatchObject({
        error_type: 'Unknown', message: expect.stringContaining('解析备份配置失败:'), details: null,
      });
      expect(host.ctx.settings.get('backup.config')).toBe(raw);
    }
  }
});

it('F4-V2-01 BackupTier rejects inherited object names through the persisted config command', async () => {
  const host = await setup();
  for (const name of ['constructor', 'toString', '__proto__']) {
    for (const tier of [name, { [name]: null }]) {
      const raw = JSON.stringify({ backupTiers: [tier] });
      host.ctx.settings.save('backup.config', raw);
      await expect(host.invoke('get_backup_config')).rejects.toMatchObject({
        error_type: 'Unknown', message: expect.stringContaining('解析备份配置失败:'), details: null,
      });
      expect(host.ctx.settings.get('backup.config')).toBe(raw);
    }
  }
});

// serde derive: duplicate known field -> `duplicate field`; unknown fields (even repeated) ignored;
// u32 visitor rejects float tokens (`24.0`) and values above u32::MAX.
it('F4-V2-01 persisted config rejects duplicate known fields and non-integer u32 tokens like serde', async () => {
  const host = await setup();
  for (const raw of [
    '{"slimBackup":false,"slimBackup":true}',
    '{"backupTiers":null,"backupTiers":["core"]}',
    '{"autoBackupIntervalHours":24.0}',
    '{"autoBackupIntervalHours":1e1}',
    '{"maxBackupCount":4294967296}',
    '{"maxBackupCount":-1}',
  ]) {
    host.ctx.settings.save('backup.config', raw);
    await expect(host.invoke('get_backup_config')).rejects.toMatchObject({
      error_type: 'Unknown', message: expect.stringContaining('解析备份配置失败:'), details: null,
    });
    expect(host.ctx.settings.get('backup.config')).toBe(raw);
  }
  host.ctx.settings.save('backup.config', '{"x":1,"x":2,"maxBackupCount":4294967295,"autoBackupIntervalHours":0}');
  expect(await host.invoke('get_backup_config')).toEqual({ backupDirectory: null,
    autoBackupEnabled: false, autoBackupIntervalHours: 0, maxBackupCount: 4294967295, slimBackup: false });
});

// serde_json from_str streams through the derive visitor: field errors win over later syntax/trailing errors.
it('ignored arbitrary-precision fields do not hide later typed config errors', async () => {
  const host = await setup();
  host.ctx.settings.save('backup.config', '{"extension":{"n":1e400},"slimBackup":true}');
  expect(await host.invoke('get_backup_config')).toMatchObject({ slimBackup: true });
  host.ctx.settings.save('backup.config', '{"extension":1e400,"maxBackupCount":1e400} trailing');
  await expect(host.invoke('get_backup_config')).rejects.toEqual({
    error_type: 'Unknown', message: '解析备份配置失败: number out of range at line 1 column 41', details: null,
  });
});

it('F4-V2-01 persisted config reports serde error priority and UTF-8 byte columns', async () => {
  const host = await setup();
  const cases: [string, string][] = [
    ['{"slimBackup":"x"} trailing', 'invalid type: string "x", expected a boolean at line 1 column 17'],
    ['{"slimBackup":true,"slimBackup":!}', 'duplicate field `slimBackup` at line 1 column 31'],
    ['{"maxBackupCount":-0}', 'invalid type: floating point `-0.0`, expected u32 at line 1 column 20'],
    ['{"autoBackupIntervalHours":24.0}', 'invalid type: floating point `24.0`, expected u32 at line 1 column 31'],
    ['{"maxBackupCount":4294967296}', 'invalid value: integer `4294967296`, expected u32 at line 1 column 28'],
    ['{"backupDirectory":"😀","slimBackup":1}', 'invalid type: integer `1`, expected a boolean at line 1 column 40'],
  ];
  for (const [raw, display] of cases) {
    host.ctx.settings.save('backup.config', raw);
    await expect(host.invoke('get_backup_config')).rejects.toEqual({
      error_type: 'Unknown', message: `解析备份配置失败: ${display}`, details: null,
    });
  }
});

it('F4-V2-01 absent bools still default and optional nulls and all BackupTier aliases remain accepted', async () => {
  const host = await setup();
  host.ctx.settings.save('backup.config', JSON.stringify({ backupDirectory: null, maxBackupCount: null,
    backupTiers: ['core', 'core_config_chat', 'important', 'vfs_full', 'rebuildable', 'large_assets', 'large_files', { core: null }],
    unknown: true }));
  expect(await host.invoke('get_backup_config')).toEqual({ backupDirectory: null,
    autoBackupEnabled: false, autoBackupIntervalHours: 24, maxBackupCount: null, slimBackup: false,
    backupTiers: ['core', 'core', 'important', 'important', 'rebuildable', 'large_assets', 'large_assets', 'core'] });
  host.ctx.settings.save('backup.config', '{"backupTiers":null}');
  expect(await host.invoke('get_backup_config')).toEqual({ backupDirectory: null,
    autoBackupEnabled: false, autoBackupIntervalHours: 24, maxBackupCount: null, slimBackup: false });
});

it('F4-V2-07 persisted BackupConfig sequences apply serde field defaults and retain enum aliases', async () => {
  const host = await setup();
  const defaults = { backupDirectory: null, autoBackupEnabled: false, autoBackupIntervalHours: 24, maxBackupCount: null, slimBackup: false };
  for (const [text, config] of [
    ['[]', defaults],
    ['[null,true]', { ...defaults, autoBackupEnabled: true }],
    ['[null,true,12,3,true,["core_config_chat",{"vfs_full":null}]]', {
      ...defaults, autoBackupEnabled: true, autoBackupIntervalHours: 12, maxBackupCount: 3, slimBackup: true,
      backupTiers: ['core', 'important'],
    }],
  ] as const) {
    host.ctx.settings.save('backup.config', text);
    expect(await host.invoke('get_backup_config')).toEqual(config);
    expect(host.ctx.settings.get('backup.config')).toBe(text);
  }
  const extra = '[null,true,12,3,true,null,!]';
  host.ctx.settings.save('backup.config', extra);
  await expect(host.invoke('clear_backup_directory')).rejects.toMatchObject({
    error_type: 'Unknown', message: expect.stringContaining('解析备份配置失败: trailing characters'),
  });
  expect(host.ctx.settings.get('backup.config')).toBe(extra);
});

it('F4-V2-07 AutoBackupStatus sequence requires five slots despite its Option fields', async () => {
  const host = await setup();
  host.ctx.settings.save('backup.auto_backup_status', '[null,"success",null,"due","job"]');
  expect(loadAutoBackupStatus(host.ctx.settings)).toEqual({
    lastAttemptAt: null, lastSuccessAt: 'success', lastError: null, nextDueAt: 'due', lastJobId: 'job',
  });
  for (const text of ['[]', '[null]']) {
    host.ctx.settings.save('backup.auto_backup_status', text);
    expect(statusError(host)).toMatchObject({
      error_type: 'Unknown', message: expect.stringContaining(`invalid length ${text === '[]' ? 0 : 1}, expected struct AutoBackupStatus with 5 elements`),
    });
  }
});

it('F4-V2-07 backup persisted structs use IgnoredAny only for unknown values', async () => {
  const host = await setup();
  const text = '{"extension":{"text":"\\ud800","n":1e400,"deep":' + '['.repeat(128) + ']'.repeat(128) + '}}';
  host.ctx.settings.save('backup.config', text);
  host.ctx.settings.save('backup.auto_backup_status', text);
  expect(await host.invoke('get_backup_config')).toMatchObject({ autoBackupIntervalHours: 24 });
  expect(loadAutoBackupStatus(host.ctx.settings)).toMatchObject({ lastJobId: null });
  host.ctx.settings.save('backup.auto_backup_status', '{"lastError":"\\ud800"}');
  expect(statusError(host)).toMatchObject({
    error_type: 'Unknown', message: expect.stringContaining('unexpected end of hex escape'),
  });
});

it('F4-V2-07 BackupTier enum map closes before extra fields and retains unit error semantics', async () => {
  const host = await setup();
  for (const [text, display] of [
    ['{"backupTiers":[{"core":null , "important":null}]}', 'expected value at line 1 column 29'],
    ['{"backupTiers":[{"core":false}]}', 'invalid type: boolean `false`, expected unit'],
  ]) {
    host.ctx.settings.save('backup.config', text!);
    await expect(host.invoke('get_backup_config')).rejects.toMatchObject({
      error_type: 'Unknown', message: expect.stringContaining(`解析备份配置失败: ${display}`),
    });
  }
});

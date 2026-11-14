/**
 * 备份只经 `ctx.paths.os.home` 取用户主目录（`dirs::home_dir()`）：外壳设置 `DS_APP_DATA_DIR`
 * 时主目录被隔离，进程 `$HOME`（`os.homedir()`）指向的真实用户目录不得被读取或出现在错误文本里。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import { createBackup } from '../src/backup-manager.ts';
import { createBackupHost, createDatabaseFile, hostBackupRoot } from './helpers.ts';

const hosts: TestHost[] = [];
const storages: StorageServiceImpl[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const storage of storages.splice(0)) storage.dispose();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function skill(home: string, name: string): void {
  const dir = join(home, '.deep-student', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `# ${name}`);
}

async function setup(options: { paths: boolean }) {
  const sandbox = mkdtempSync(join(tmpdir(), 'w08-home-isolation-'));
  dirs.push(sandbox);
  const isolatedHome = join(sandbox, 'isolated-home');
  // 进程级 $HOME 代表"真实用户目录"：放一个诱饵技能，隔离后不得被备份。
  const realHome = join(sandbox, 'real-home');
  skill(realHome, 'real-user-skill');
  vi.stubEnv('HOME', realHome);
  vi.stubEnv('USERPROFILE', realHome);
  const { host } = await createBackupHost({
    storageFactory: dataDir => {
      const storage = createStorageService({ baseDir: dataDir, dataLocalDir: dataDir });
      storages.push(storage);
      return storage;
    },
    ...(options.paths ? {
      paths: createPaths({
        dataDir: join(sandbox, 'app'), platform: process.platform === 'darwin' ? 'darwin' : 'linux',
        env: { HOME: isolatedHome, XDG_DATA_HOME: join(sandbox, 'data'), XDG_CONFIG_HOME: join(sandbox, 'config') },
      }),
    } : {}),
  });
  hosts.push(host);
  const appRoot = host.app.dataDir;
  const activeDir = join(appRoot, 'slots', 'slotA');
  createDatabaseFile(join(activeDir, 'databases', 'vfs.db'));
  createDatabaseFile(join(activeDir, 'mistakes.db'));
  createDatabaseFile(join(activeDir, 'llm_usage.db'));
  createDatabaseFile(join(activeDir, 'chat_v2.db'));
  return { host, appRoot, activeDir, realHome, isolatedHome };
}

function userSkillFiles(files: readonly { path: string }[]): string[] {
  return files.map(file => file.path).filter(path => path.startsWith('persistent/user_skills/')).sort();
}

it('backs up user skills from the isolated ctx.paths home, never from process $HOME', async () => {
  const { host, appRoot, activeDir, isolatedHome } = await setup({ paths: true });
  skill(isolatedHome, 'isolated-skill');
  const manifest = await createBackup(
    { ctx: host.ctx, backupRoot: hostBackupRoot(host), activeDir, baseDir: appRoot },
    { includeAssets: false, backupIdSuffix: 'home' },
  );
  expect(userSkillFiles(manifest.files)).toEqual(['persistent/user_skills/isolated-skill/SKILL.md']);
});

it('falls back to <active slot>/.deep-student/skills without ctx.paths (Rust home_dir() None branch)', async () => {
  const { host, appRoot, activeDir } = await setup({ paths: false });
  skill(activeDir, 'slot-skill');
  const manifest = await createBackup(
    { ctx: host.ctx, backupRoot: hostBackupRoot(host), activeDir, baseDir: appRoot },
    { includeAssets: false, backupIdSuffix: 'nohome' },
  );
  expect(userSkillFiles(manifest.files)).toEqual(['persistent/user_skills/slot-skill/SKILL.md']);
});

it('sanitizes user-facing paths against the ctx.paths home, not process $HOME', async () => {
  const { host, realHome, isolatedHome } = await setup({ paths: true });
  await expect(host.invoke('data_governance_import_zip', { zipPath: join(isolatedHome, 'exports', 'missing.zip') }))
    .rejects.toBe('ZIP 文件不存在: ~/exports/missing.zip。请确认文件路径正确，或重新选择文件');
  // 真实主目录下的路径不按 `~/` 缩写（它不是本应用看到的主目录），只保留最后两级。
  await expect(host.invoke('data_governance_import_zip', { zipPath: join(realHome, 'exports', 'missing.zip') }))
    .rejects.toBe('ZIP 文件不存在: .../exports/missing.zip。请确认文件路径正确，或重新选择文件');
});

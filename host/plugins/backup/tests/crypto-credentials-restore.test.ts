import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { createPaths } from '../../../platform/paths/index.ts';
import { createSecretsService } from '../../../platform/secrets/index.ts';
import { backupCryptoKeys } from '../src/backup-manager.ts';
import { newManifest } from '../src/manifest.ts';
import { publishRestoreKeysAndCommitCutover } from '../src/restore-commands.ts';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it.each([false, true])('restores real backed-up encrypted credentials (cutover failure: %s)', async failCutover => {
  const root = mkdtempSync(join(tmpdir(), 'dstu-crypto-credentials-'));
  directories.push(root);
  const source = join(root, 'source');
  const target = join(root, 'target');
  const archive = join(root, 'archive');
  for (const directory of [source, target, archive]) mkdirSync(directory);
  const env = { HOME: join(root, 'home'), XDG_DATA_HOME: join(root, 'data'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache') };
  const paths = createPaths({ dataDir: root, env, platform: 'linux' });
  const log = { target: 'crypto-restore-test', info() {}, warn() {}, error() {}, debug() {}, trace() {} };
  const secrets = createSecretsService({ os: paths.os, env, keystore: null, log });
  const context = (dataDir: string) => ({ app: { dataDir }, secrets, logger: () => log }) as unknown as Context;
  await secrets.openStore(source).saveSecret('backup_probe', 'archived credential');
  await secrets.openStore(target).saveSecret('backup_probe', 'original credential');
  const manifest = newManifest('0.0.0-test');
  expect(backupCryptoKeys(context(source), archive, manifest)).toBe(2);
  const archivedSeed = readFileSync(join(archive, 'crypto', '.secure', '.key_seed'));
  const openStore = secrets.openStore.bind(secrets);
  vi.spyOn(secrets, 'openStore').mockImplementation((dataDir, options) => {
    const store = openStore(dataDir, options);
    const getSecret = store.getSecret.bind(store);
    store.getSecret = async key => {
      const value = await getSecret(key);
      // 平台种子迁移可在读取时改写文件；模拟有效的字节变化，不替换真实解密。
      if (value !== null) {
        const seedPath = join(dataDir, '.secure', '.key_seed');
        writeFileSync(seedPath, `${readFileSync(seedPath, 'utf8')}\n`);
      }
      return value;
    };
    return store;
  });

  let cutoverCalled = false;
  const restore = publishRestoreKeysAndCommitCutover(context(target), manifest, archive, 'slotB', () => {
    cutoverCalled = true;
    if (failCutover) throw new Error('injected cutover failure');
  });
  if (failCutover) await expect(restore).rejects.toThrow('已恢复旧密钥');
  else await expect(restore).resolves.toBe(2);
  expect(cutoverCalled).toBe(true);
  expect(await secrets.openStore(target).getSecret('backup_probe'))
    .toBe(failCutover ? 'original credential' : 'archived credential');
  expect(existsSync(join(archive, '.secure'))).toBe(false);
  expect(readFileSync(join(archive, 'crypto', '.secure', '.key_seed'))).toEqual(archivedSeed);
  expect(existsSync(secrets.publication.journalPath(target))).toBe(false);
});

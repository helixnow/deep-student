/**
 * `SecureStore::new()` fallback dir (`dstu-security/src/secure_store.rs:666-689`): when
 * `<data_local_dir>/deep-student/.secure` cannot be created, Rust silently moves the master seed and every
 * encrypted secret into `<temp_dir>/deep-student/.secure`. The seed is the only key for those secrets and the
 * temp dir is purged by the OS (tmpfs on reboot, macOS periodic cleanup), and on Linux `/tmp` is shared, so
 * another user can pre-create `deep-student/` and own the parent of the seed directory.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { OsDirs } from '../../paths/api.ts';
import { createSecretsService } from '../index.ts';
import type { Logger } from '../../log/api.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const silent: Logger = { target: 't', error() {}, warn() {}, info() {}, debug() {}, trace() {} };

it('RF-W07-secure-store-temp-fallback: an uncreatable data_local secure dir is an error, never <temp>/deep-student/.secure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f4-secure-fallback-'));
  dirs.push(root);
  const blocker = join(root, 'data-local-is-a-file');
  writeFileSync(blocker, '');
  const temp = join(root, 'temp');
  const os: OsDirs = { home: root, data: blocker, dataLocal: blocker, config: blocker, cache: blocker, temp, download: null };
  const store = createSecretsService({ os, log: silent, keystore: null, env: { DEEP_STUDENT_KEY_SEED_FILE_ONLY: '1' } })
    .openFallbackStore();

  // Rust: create_dir_all(temp/deep-student/.secure) succeeds and the seed is written there.
  await expect(store.saveSecret('api_key', 'sk-test')).rejects.toThrow(/创建安全目录失败/);
  expect(existsSync(join(temp, 'deep-student'))).toBe(false);
});

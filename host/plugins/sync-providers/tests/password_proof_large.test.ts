import './local-fs-fixture.ts';
import { mkdtemp, open, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { provePasswordAgainstExistingBackups, type PasswordProofPorts } from '../src/password_proof.ts';
import { MemoryStorage } from './memory_storage.ts';

const dirs: string[] = [];
afterEach(async () => { while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true }); });

describe('sync_manager.rs password proof (whole-file path)', () => {
  it('sniffs only the 4-byte header of a > 2 GiB plaintext ZIP (sync_manager.rs:1436-1460)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'proof-large-'));
    dirs.push(dir);
    const localPath = join(dir, 'backup.zip');
    const handle = await open(localPath, 'w');
    await handle.write(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 0, 4, 0);
    await handle.close();
    await truncate(localPath, 2_200_000_000);

    const storage = new MemoryStorage();
    const version = { id: 'v1', timestamp: '2026-01-01T00:00:00Z', size: 2_200_000_000n, checksum: '', deviceId: 'd' };
    const ports: PasswordProofPorts = {
      storage,
      backup: createBackupCrypto(),
      backupObjectKey: id => `backups/${id}.zip`,
      getManifest: async () => ({ version: 1, latest: 'v1', versions: [version], updatedAt: '2026-01-01T00:00:00Z' }),
      downloadVersion: async () => ({ version: { ...version, size: 2_200_000_000 }, localPath }),
    };
    await expect(provePasswordAgainstExistingBackups(ports, 'local-password', true)).resolves.toBeUndefined();
  });
});

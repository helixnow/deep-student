import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../paths/index.ts';
import log from '../../log/index.ts';
import secrets from '../index.ts';

// crypto_publication.rs:139-145 deserializes the byte slice before any rename/delete.
it('F4-V2-02 corrupted_journal_fails_closed on invalid UTF-8 without rolling back or deleting evidence', async () => {
  const host = await createTestHost();
  try {
    host.ctx.provide('paths', createPaths({ dataDir: host.app.dataDir, platform: host.app.platform,
      env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir } }));
    await host.install(log);
    await host.install(secrets);
    const root = host.app.dataDir;
    const publication = host.ctx.secrets.publication;
    const rollback = publication.rollbackDir(root);
    await mkdir(rollback);
    await writeFile(join(rollback, '.master_key'), 'old-master');
    await writeFile(join(root, '.master_key'), 'new-master');
    const bytes = Buffer.concat([
      Buffer.from('{"version":1,"had_old_master":true,"had_old_secure":false,"installs_master":true,"installs_secure":false,"created_at":"'),
      Buffer.from([0xff]), Buffer.from('"}'),
    ]);
    await writeFile(publication.journalPath(root), bytes);
    for (const lease of [null, ['backup', 'slotB'] as const]) {
      await expect(publication.recover(root, lease)).rejects.toMatchObject({
        kind: 'InvalidData', message: expect.stringContaining('密钥发布 journal 损坏，拒绝在不确定密钥状态上启动:'),
      });
      expect(await readFile(join(root, '.master_key'), 'utf8')).toBe('new-master');
      expect(await readFile(join(rollback, '.master_key'), 'utf8')).toBe('old-master');
      expect(await readFile(publication.journalPath(root))).toEqual(bytes);
    }
  } finally { await host.dispose(); }
});

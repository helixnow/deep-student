import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../paths/index.ts';
import log from '../../log/index.ts';
import secrets from '../index.ts';

const journal = '{"version":1,"had_old_master":true,"had_old_secure":false,"installs_master":true,"installs_secure":false,"created_at":"ok"}';

async function setup() {
  const host = await createTestHost();
  host.ctx.provide('paths', createPaths({ dataDir: host.app.dataDir, platform: host.app.platform,
    env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir } }));
  await host.install(log);
  await host.install(secrets);
  const publication = host.ctx.secrets.publication;
  const root = host.app.dataDir;
  const savedKey = join(publication.rollbackDir(root), '.master_key');
  const liveKey = join(root, '.master_key');
  await mkdir(publication.rollbackDir(root));
  await writeFile(savedKey, 'old-master');
  await writeFile(liveKey, 'new-master');
  return { host, publication, root, savedKey, liveKey };
}

// F4-V2-05: crypto_publication.rs:25-38 derives Deserialize; :139-145 parses BEFORE rollback.
it.each([
  ['float version', journal.replace('"version":1', '"version":1.0'), 'invalid type: floating point `1.0`, expected u32'],
  ['negative zero', journal.replace('"version":1', '"version":-0'), 'invalid type: floating point `-0.0`, expected u32'],
  ['overflow version', journal.replace('"version":1', '"version":4294967296'), 'invalid value: integer `4294967296`, expected u32'],
  ['duplicate version', journal.replace('"version":1', '"version":0,"version":1'), 'duplicate field `version`'],
  ['duplicate with invalid second value', journal.replace('"version":1', '"version":1,"version":!'), 'duplicate field `version`'],
  ['duplicate Option after null', journal.replace('"version":1', '"backup_id":null,"backup_id":"backup","version":1'), 'duplicate field `backup_id`'],
  ['missing required', '{}', 'missing field `version` at line 1 column 2'],
  ['type before trailing', journal.replace('"version":1', '"version":false') + ' trailing', 'invalid type: boolean `false`, expected u32'],
  ['surrogate in known field', journal.replace('"ok"', '"\\ud800"'), 'unexpected end of hex escape'],
])('F4-V2-05 rejects %s before touching any key or journal', async (_name, text, display) => {
  const { host, publication, root, savedKey, liveKey } = await setup();
  try {
    const path = publication.journalPath(root);
    await writeFile(path, text);
    for (const lease of [null, ['backup', 'slotB'] as const]) {
      await expect(publication.recover(root, lease)).rejects.toMatchObject({
        kind: 'InvalidData', message: expect.stringContaining(`密钥发布 journal 损坏，拒绝在不确定密钥状态上启动: ${display}`),
      });
      expect(await readFile(path, 'utf8')).toBe(text);
      expect(await readFile(savedKey, 'utf8')).toBe('old-master');
      expect(await readFile(liveKey, 'utf8')).toBe('new-master');
    }
  } finally { await host.dispose(); }
});

it('F4-V2-05 valid journal ignores arbitrary unknown fields and still rolls back using required fields', async () => {
  const { host, publication, root, liveKey } = await setup();
  try {
    const ignored = '{"extension":1e400,"extension":{"u":"\\ud800","deep":' + '['.repeat(128) + ']'.repeat(128) + '},';
    await writeFile(publication.journalPath(root), ignored + journal.slice(1));
    expect(await publication.recover(root, null)).toBe('RolledBack');
    expect(await readFile(liveKey, 'utf8')).toBe('old-master');
    await expect(readFile(publication.journalPath(root))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await host.dispose(); }
});

it.each([
  ['[1,null,null,true,false,true,false,"ok"]', null, 'RolledBack', 'old-master'],
  ['[1,"backup","slotB",true,false,true,false,"ok"]', ['backup', 'slotB'] as const, 'RolledForward', 'new-master'],
] as const)('F4-V2-06 accepts derive struct sequence %s in field declaration order', async (text, lease, recovery, expectedKey) => {
  const { host, publication, root, liveKey } = await setup();
  try {
    await writeFile(publication.journalPath(root), text);
    expect(await publication.recover(root, lease)).toBe(recovery);
    expect(await readFile(liveKey, 'utf8')).toBe(expectedKey);
    await expect(readFile(publication.journalPath(root))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await host.dispose(); }
});

it.each([
  ['[]', 'invalid length 0, expected struct CryptoPublicationJournal with 8 elements'],
  // Option fields are optional in the map, but still occupy positions in visit_seq (no #[serde(default)]).
  ['[1]', 'invalid length 1, expected struct CryptoPublicationJournal with 8 elements'],
  ['[1,null,null,true,false,true,false]', 'invalid length 7, expected struct CryptoPublicationJournal with 8 elements'],
  ['[1,null,null,true,false,true,false,"ok",!]', 'trailing characters'],
  ['[1,null,null,true,false,true,false,"ok",]', 'trailing comma'],
  ['[1.0,null,null,true,false,true,false,"ok",!]', 'invalid type: floating point `1.0`, expected u32'],
])('F4-V2-06 rejects malformed journal sequence %s before recovery', async (text, display) => {
  const { host, publication, root, savedKey, liveKey } = await setup();
  try {
    const path = publication.journalPath(root);
    await writeFile(path, text);
    await expect(publication.recover(root, null)).rejects.toMatchObject({
      kind: 'InvalidData', message: expect.stringContaining(`密钥发布 journal 损坏，拒绝在不确定密钥状态上启动: ${display}`),
    });
    expect(await readFile(path, 'utf8')).toBe(text);
    expect(await readFile(savedKey, 'utf8')).toBe('old-master');
    expect(await readFile(liveKey, 'utf8')).toBe('new-master');
  } finally { await host.dispose(); }
});

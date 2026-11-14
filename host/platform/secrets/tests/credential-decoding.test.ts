import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createTestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../paths/index.ts';
import log from '../../log/index.ts';
import secrets from '../index.ts';

const ACTIVE = 'cloud_storage_credentials';
const STAGED = 'cloud_storage_credentials_staged';
const GENERATION = 'cloud_storage_credentials_generation';

async function setup() {
  const host = await createTestHost();
  host.ctx.provide('paths', createPaths({ dataDir: host.app.dataDir, platform: host.app.platform,
    env: { HOME: host.app.dataDir, USERPROFILE: host.app.dataDir, APPDATA: host.app.dataDir, LOCALAPPDATA: host.app.dataDir } }));
  await host.install(log);
  await host.install(secrets);
  return { host, store: host.ctx.secrets.openStore(host.app.dataDir) };
}

// secure_store.rs:2136-2154,2419: active credentials are a typed derived struct, not a Value map.
it.each([
  ['{"webdavPassword":"old","webdavPassword":"new"}', 'duplicate field `webdavPassword`'],
  ['{"ftpPassword":null,"ftpPassword":"new"}', 'duplicate field `ftpPassword`'],
  ['{"encryptionPassword":"\\ud800"}', 'unexpected end of hex escape'],
  ['{"s3SecretAccessKey":1} trailing', 'invalid type: integer `1`, expected a string'],
])('F4-V2-08 active credentials reject %s through the kernel without rewriting storage', async (text, display) => {
  const { host, store } = await setup();
  try {
    await store.saveSecret(ACTIVE, text);
    await expect(host.invoke('secure_get_cloud_credentials')).rejects.toMatchObject({
      code: 'SECURE_STORE_DATA_INVALID', message: expect.stringContaining(`序列化错误: ${display}`),
      data: { operation: 'get_cloud_credentials', retryable: false },
    });
    expect(await store.getSecret(ACTIVE)).toBe(text);
  } finally { await host.dispose(); }
});

it.each([
  ['{"generation":0,"generation":1,"credentials":{"webdavPassword":"new"}}', 'duplicate field `generation`'],
  ['{"generation":1,"credentials":{"webdavPassword":null,"webdavPassword":"new"}}', 'duplicate field `webdavPassword`'],
  ['{"generation":1.0,"credentials":{}} trailing', 'invalid type: floating point `1.0`, expected u64'],
  ['{"generation":-0,"credentials":{}}', 'invalid type: floating point `-0.0`, expected u64'],
  ['{"generation":1,"credentials":{"webdavPassword":"\\ud800"}}', 'unexpected end of hex escape'],
])('F4-V2-08 commit rejects malformed staged credentials %s before publishing', async (text, display) => {
  const { host, store } = await setup();
  try {
    const active = '{"webdavPassword":"old"}';
    await store.saveSecret(ACTIVE, active);
    await store.saveSecret(GENERATION, '0');
    await store.saveSecret(STAGED, text);
    await expect(store.commitStagedCloudCredentials(1n)).rejects.toMatchObject({
      kind: 'SerializationError', detail: expect.stringContaining(`云凭据 staged 记录非法: ${display}`),
    });
    expect(await store.getSecret(ACTIVE)).toBe(active);
    expect(await store.getSecret(STAGED)).toBe(text);
    expect(await store.cloudCredentialsActiveGeneration()).toBe(0n);
  } finally { await host.dispose(); }
});

it('F4-V2-08 credentials accept defaulted struct sequences and exact u64 staged tuples', async () => {
  const { host, store } = await setup();
  try {
    await store.saveSecret(ACTIVE, '["old",null,"ftp"]');
    expect(await host.invoke('secure_get_cloud_credentials')).toEqual({
      webdavPasswordConfigured: true, s3SecretAccessKeyConfigured: false, ftpPasswordConfigured: true, encryptionPasswordConfigured: false,
    });
    const max = (1n << 64n) - 1n;
    await store.saveSecret(GENERATION, (max - 1n).toString());
    await store.saveSecret(STAGED, `[${max},["new"]]`);
    await store.commitStagedCloudCredentials(max);
    expect(await store.cloudCredentialsActiveGeneration()).toBe(max);
    expect(await store.getCloudCredentials()).toEqual({ webdavPassword: 'new' });
    expect(await store.getSecret(STAGED)).toBeNull();
  } finally { await host.dispose(); }
});

it('F4-V2-08 known credentials stay strict while unknown values use IgnoredAny', async () => {
  const { host, store } = await setup();
  try {
    const unknown = '"extension":{"n":1e400,"s":"\\ud800","deep":' + '['.repeat(128) + ']'.repeat(128) + '}';
    await store.saveSecret(ACTIVE, `{${unknown},"webdavPassword":"active"}`);
    expect(await store.getCloudCredentials()).toEqual({ webdavPassword: 'active' });
    await store.saveSecret(STAGED, `{${unknown},"generation":1,"credentials":{${unknown},"webdavPassword":"staged"}}`);
    await store.commitStagedCloudCredentials(1n);
    expect(await store.getCloudCredentials()).toEqual({ webdavPassword: 'staged' });
  } finally { await host.dispose(); }
});

it('F4-V2-08 abort cleans malformed staged records and logs serde Display without changing active state', async () => {
  const { host, store } = await setup();
  try {
    const active = '{"webdavPassword":"active"}';
    await store.saveSecret(ACTIVE, active);
    await store.saveSecret(GENERATION, '0');
    await store.saveSecret(STAGED, '{"generation":1,"generation":2,"credentials":{}}');
    // secure_store.rs:2673-2687: abort is the explicit corrupted-record cleanup path, unlike commit.
    await store.abortStagedCloudCredentials(1n);
    expect(await store.getSecret(STAGED)).toBeNull();
    expect(await store.getSecret(ACTIVE)).toBe(active);
    expect(await store.cloudCredentialsActiveGeneration()).toBe(0n);
    const text = await readFile(host.ctx.log.mainLogFile, 'utf8');
    expect(text).toContain('清除无法解析的云凭据 staged 记录: duplicate field `generation` at line 1 column');
    expect(text).not.toContain('JsonSyntaxError:');
  } finally { await host.dispose(); }
});

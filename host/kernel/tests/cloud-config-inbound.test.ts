import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import backup from '../../plugins/backup/index.ts';
import cloudCommands from '../../platform/errors/cloud-config-commands.ts';
import { StorageCordisService } from '../../platform/storage/service.ts';
import { createTestHost, type TestHost } from '../testing.ts';
import { serdeCheck } from '../serde.ts';

const hosts: TestHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose(); });
const prefix = 'invalid args `config` for command `cloud_config_ssot_save`: ';
const webdav = { endpoint: 'https://dav.equivalence.invalid/remote.php/dav', username: 'student' };

class CloudConfigTestStorage extends StorageCordisService {
  constructor(ctx: Context) {
    super(ctx, { dataLocalDir: ctx.app.dataDir });
  }
}

async function boot() {
  // Use the complete production storage service, scoped to the test data directory.
  // Both the F4 command plugin and L21 cloudConfig service use production entry points.
  const stored = new Map<string, string>();
  const save = vi.fn((key: string, value: string) => { stored.set(key, value); });
  const host = await createTestHost({
    plugins: [backup, cloudCommands],
    provide: {
      settings: { get: (key: string) => stored.get(key) ?? null, save },
      secrets: {},
      storage: CloudConfigTestStorage,
    },
  });
  hosts.push(host);
  return { host, stored, save };
}

it('WP-287 G3 camelCase is rejected before the production save service writes', async () => {
  const { host, stored, save } = await boot();
  const corpus = JSON.parse(readFileSync('host/platform/settings/equivalence/cloud-config.json', 'utf8'));
  const scenario = corpus.scenarios.find((s: { id: string }) => s.id === 'settings.cloud.save.https_allow_insecure_false_omitted');
  const steps = scenario.steps.filter((s: { cmd: string }) => s.cmd === 'cloud_config_ssot_save');
  expect(steps).toHaveLength(2);
  for (const step of steps) {
    await expect(host.invoke(step.cmd, step.args)).rejects.toBe(
      prefix + 'unknown field `allowInsecure`, expected one of `webdav`, `root`, `allow_insecure`');
    expect(await host.runtime.dispatchInvoke({ id: 'g3', cmd: step.cmd, args: {}, argsJson: JSON.stringify(step.args),
      source: { window: 'main', webview: 'main' } })).toEqual({ kind: 'err',
      error: prefix + 'unknown field `allowInsecure`, expected one of `webdav`, `root`, `allow_insecure`' });
  }
  expect(save).not.toHaveBeenCalled();
  expect([...stored]).toEqual([]);
  expect(host.events).toEqual([]);
});

it('WP-287 accepts exact snake_case false/true through the production save service', async () => {
  const { host, stored, save } = await boot();
  const serviceSave = vi.spyOn(host.ctx.cloudConfig, 'save');
  for (const allow_insecure of [false, true]) {
    const config = { provider: 'webdav', webdav, allow_insecure };
    const result = await host.invoke('cloud_config_ssot_save', { config });
    expect(result).toMatchObject({ configured: true, provider: 'webdav' });
    expect(serviceSave).toHaveBeenLastCalledWith(config);
    expect(await host.runtime.dispatchInvoke({ id: 'valid', cmd: 'cloud_config_ssot_save', args: {},
      argsJson: JSON.stringify({ config }), source: { window: 'main', webview: 'main' } }))
      .toMatchObject({ kind: 'ok', value: { configured: true, provider: 'webdav' } });
    expect(serviceSave).toHaveBeenLastCalledWith(config);
    expect(save).toHaveBeenCalledTimes(allow_insecure ? 4 : 2);
    const persisted = JSON.parse(stored.get('cloud_storage.config.safe_v1')!);
    expect(persisted.provider).toBe('webdav');
    expect(persisted.webdav).toEqual(webdav);
    expect(Object.hasOwn(persisted, 'allowInsecure')).toBe(false);
  }
});

// serde 1.0.228 TaggedContentVisitor reads the tag before deserializing the
// buffered fields. Then visit_map follows input order; missing fields come last.
it.each([
  [{ provider: 'webdav', webdav: { ...webdav, password: 'secret' } }, 'unknown field `password`, expected `endpoint` or `username`'],
  [{ provider: 'webdav' }, 'missing field `webdav`'],
  [{ provider: 'webdav', webdav: {} }, 'missing field `endpoint`'],
  [{ provider: 'webdav', webdav: { endpoint: webdav.endpoint } }, 'missing field `username`'],
  [{ allowInsecure: false, provider: 'webdav', webdav: {} }, 'unknown field `allowInsecure`, expected one of `webdav`, `root`, `allow_insecure`'],
  [{ webdav: {}, provider: 'webdav', allowInsecure: false }, 'missing field `endpoint`'],
  [{ root: false, provider: 'webdav', webdav: {} }, 'invalid type: boolean `false`, expected a string'],
  [{ allow_insecure: 'false', provider: 'webdav', webdav: {} }, 'invalid type: string "false", expected a boolean'],
  [{ allowInsecure: false }, 'missing field `provider`'],
  [{ allowInsecure: false, provider: 'unknown', webdav: {} }, 'unknown variant `unknown`, expected one of `webdav`, `s3`, `ftp`'],
  [{ allowInsecure: false, provider: false }, 'invalid type: boolean `false`, expected variant identifier'],
  [{ provider: 's3', s3: { endpoint: 'https://s3.example.test', bucket: 'b', accessKeyId: 'a', access_key_id: 'bad' } }, 'unknown field `access_key_id`, expected one of `endpoint`, `bucket`, `accessKeyId`, `region`, `pathStyle`'],
  [{ provider: 'ftp', allowInsecure: false }, 'unknown field `allowInsecure`, expected one of `ftp`, `root`, `allow_insecure`'],
])('WP-287 exact first error for %j', async (config, detail) => {
  const { host, stored, save } = await boot();
  await host.invoke('cloud_config_ssot_save', { config: { provider: 'webdav', webdav, allow_insecure: false } });
  const before = [...stored];
  save.mockClear();
  await expect(host.invoke('cloud_config_ssot_save', { config })).rejects.toBe(prefix + detail);
  expect(await host.runtime.dispatchInvoke({ id: 'first-error', cmd: 'cloud_config_ssot_save', args: {},
    argsJson: JSON.stringify({ config }), source: { window: 'main', webview: 'main' } }))
    .toEqual({ kind: 'err', error: prefix + detail });
  expect(save).not.toHaveBeenCalled();
  expect([...stored]).toEqual(before);
  expect(host.events).toEqual([]);
});

it('WP-287 leaves ambiguous unions and buffered numbers on the existing unknown path', () => {
  const branches = ['a', 'b'].map(tag => ({ type: 'object', properties: {
    tag: { const: tag }, content: { type: 'string' }, flag: { type: 'boolean' },
  }, required: ['tag', 'content'], additionalProperties: false }));
  const resolver = { resolve: () => undefined };
  const rust = { 'x-rust': 'fixture::Enum' };
  expect(serdeCheck({ ...rust, anyOf: branches }, { tag: 'a', extra: false }, '', resolver)).toEqual({ ok: 'unknown' });
  expect(serdeCheck({ oneOf: branches }, { tag: 'a', extra: false }, '', resolver)).toEqual({ ok: 'unknown' });
  const adjacent = branches.map(branch => ({ ...branch, properties: { tag: branch.properties.tag, content: branch.properties.content } }));
  expect(serdeCheck({ ...rust, oneOf: adjacent }, { tag: 'a', extra: false }, '', resolver)).toEqual({ ok: 'unknown' });
  expect(serdeCheck({ ...rust, oneOf: branches }, { tag: 'a', content: 3, extra: false }, '', resolver)).toEqual({ ok: 'unknown' });
  expect(serdeCheck({ ...rust, oneOf: branches }, ['a', 'value', false], '', resolver)).toEqual({ ok: 'unknown' });
});

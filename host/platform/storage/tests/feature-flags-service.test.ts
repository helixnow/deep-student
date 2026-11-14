import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import secrets from '../../secrets/index.ts';
import settings from '../../settings/index.ts';
import storage from '../index.ts';

let base: string;
let host: Awaited<ReturnType<typeof createTestHost>>;
beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-flags-service-'));
  host = await createTestHost({
    app: { dataDir: base },
    plugins: [secrets, [storage, { dataLocalDir: base }], settings],
    provide: {
      paths: { os: { home: base, data: base, dataLocal: base, config: base, temp: base } },
      log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
    },
  });
}, 60_000);
afterAll(async () => {
  await host?.dispose();
  fs.rmSync(base, { recursive: true, force: true });
});

const store = {
  getSetting: (key: string) => host.ctx.settings.get(key),
  saveSetting: (key: string, value: string) => host.ctx.settings.save(key, value),
};

// feature_flags.rs:397-403: Vec<u64>::cmp, not semver or padded number arrays.
it.each([
  ['1.0', '1.0.0', null, false],
  ['1.0.0', null, '1.0', false],
  ['1beta', '1', null, false],
  [' 1', '1', null, false],
  ['+1.02', '1.2', '1.2', true],
  ['18446744073709551616', null, '0', true],
  ['9007199254740992', '9007199254740993', null, false],
  ['18446744073709551615', '18446744073709551614', null, true],
  ['1..3', '1.0.3', '1.0.3', true],
] as const)('test_feature_flag_manager: version %s in [%s, %s] is %s', (version, min, max, enabled) => {
  const service = host.ctx.featureFlags;
  const manager = service.load(store, version);
  const flag = service.withVersionRange(service.enable(service.newFlag('version-test', 'version test', 'test')), min, max);
  manager.updateFlag(flag.name, flag);
  expect(manager.isFeatureEnabled(flag.name)).toBe(enabled);
});

it('test_feature_flag_manager: load errors keep the Rust context before any default flags are returned', () => {
  const failure = vi.spyOn(host.ctx.settings, 'get').mockImplementation(() => { throw new Error('disk read failed'); });
  try {
    expect(() => host.ctx.featureFlags.load(store, '1.0')).toThrow('Failed to load feature flags: disk read failed');
  } finally { failure.mockRestore(); }
});

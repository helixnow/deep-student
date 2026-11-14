import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import packageJson from '../../package.json' with { type: 'json' };
import { createTestHost } from '../../host/kernel/testing.ts';
import { buildInfo } from '../build-info.ts';
import plugin from '../index.ts';

// commands.rs:500-507 has no AppHandle or Result: metadata must work without main.
it.each([true, false])('get_app_version preserves the full build string without Shell (debug=%s)', async (debug) => {
  const info = buildInfo(resolve(import.meta.dirname, '../..'), packageJson.version);
  const expected = `${info.version} (Build ${info.buildNumber}, ${info.gitHash})`;
  const host = await createTestHost({ plugins: [plugin], app: { debug, version: 'headless' } });
  try {
    await expect(host.invoke('get_app_version')).resolves.toBe(expected);
    await expect(host.invoke('get_app_version')).resolves.toBe(expected);
    expect(host.shellRequests).toEqual([]);
  } finally { await host.dispose(); }
});

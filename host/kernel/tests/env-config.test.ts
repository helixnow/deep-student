/** 桌面入口的环境变量 → 插件配置映射（`env-config.ts`），经 `configOverrides` 进入 profile 配置。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ContractSet } from '../contracts.ts';
import { envConfigOverrides, HOST_CALL_CALLER_ENV, hostCallCallerMode } from '../env-config.ts';
import { loadStartupProfile } from '../profile.ts';
import { DEFAULT_HOST_CALL_CALLER_MODE } from '../runtime.ts';
import { createTestHost } from '../testing.ts';

const ECHO = fileURLToPath(new URL('../__fixtures__/plugin-manifest/config-echo.plugin.ts', import.meta.url));

describe('W01 env → plugin config', () => {
  it('maps DEEP_STUDENT_HPIAS_BACKEND to dstu.memory hpiasBackend (raw value, set only when the variable is set)', async () => {
    expect(envConfigOverrides({})).toEqual({});
    expect(envConfigOverrides({ DEEP_STUDENT_HPIAS_BACKEND: 'stub' })).toEqual({ 'dstu.memory': { hpiasBackend: 'stub' } });
    expect(envConfigOverrides({ DEEP_STUDENT_HPIAS_BACKEND: '' })).toEqual({ 'dstu.memory': { hpiasBackend: '' } });
    const desktop = JSON.parse(await readFile(new URL('../../profiles/desktop.json', import.meta.url), 'utf8')) as { plugins: { id: string }[] };
    expect(desktop.plugins.map(p => p.id)).toContain('dstu.memory');
  });

  it('maps DEEP_STUDENT_WEBDAV_RATE_LIMIT to dstu.sync-providers webdavRateLimit (raw value, the plugin parses and falls back like Rust)', async () => {
    expect(envConfigOverrides({ DEEP_STUDENT_WEBDAV_RATE_LIMIT: '0' })).toEqual({ 'dstu.sync-providers': { webdavRateLimit: '0' } });
    expect(envConfigOverrides({ DEEP_STUDENT_WEBDAV_RATE_LIMIT: 'abc' })).toEqual({ 'dstu.sync-providers': { webdavRateLimit: 'abc' } });
    expect(envConfigOverrides({ DEEP_STUDENT_WEBDAV_RATE_LIMIT: '120', DEEP_STUDENT_HPIAS_BACKEND: 'stub' })).toEqual({
      'dstu.memory': { hpiasBackend: 'stub' },
      'dstu.sync-providers': { webdavRateLimit: '120' },
    });
    const desktop = JSON.parse(await readFile(new URL('../../profiles/desktop.json', import.meta.url), 'utf8')) as { plugins: { id: string }[] };
    expect(desktop.plugins.map(p => p.id)).toContain('dstu.sync-providers');
  });

  it('overrides are merged over the profile config before apply', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'w01-env-config-'));
    const g = globalThis as { __w01ConfigEcho?: unknown[] };
    g.__w01ConfigEcho = [];
    const host = await createTestHost({ contracts: ContractSet.empty() });
    try {
      const profile = join(dir, 'profile.json');
      await writeFile(profile, JSON.stringify({ plugins: [{ id: 'fixture.config-echo', module: ECHO, config: { keep: 1, hpiasBackend: 'disabled' } }] }));
      await loadStartupProfile(host.runtime, { profile, configOverrides: { 'fixture.config-echo': { hpiasBackend: 'retrieval' }, 'dstu.absent': { x: 1 } } });
      expect(g.__w01ConfigEcho).toEqual([{ keep: 1, hpiasBackend: 'retrieval' }]);
    } finally {
      await host.dispose();
      delete g.__w01ConfigEcho;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('DS_HOST_CALL_CALLER can only tighten plugin:host|call to require a caller', () => {
    expect(HOST_CALL_CALLER_ENV).toBe('DS_HOST_CALL_CALLER');
    expect(hostCallCallerMode({})).toBe(DEFAULT_HOST_CALL_CALLER_MODE);
    expect(hostCallCallerMode({ DS_HOST_CALL_CALLER: 'require' })).toBe('require');
    for (const value of ['warn', 'off', '', 'REQUIRE', ' require']) {
      expect(hostCallCallerMode({ DS_HOST_CALL_CALLER: value }), JSON.stringify(value)).toBe(DEFAULT_HOST_CALL_CALLER_MODE);
    }
    // The switch is not a plugin config key.
    expect(envConfigOverrides({ DS_HOST_CALL_CALLER: 'require' })).toEqual({});
  });
});

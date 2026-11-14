import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROXY_ENV_KEYS } from '../../../host/platform/http/proxy.ts';
import hostConfig from '../../../vitest.host.config.ts';
import { PROXY_ENV_VARS, clearProxyEnv } from './host-test-env.mjs';

const ROOT = path.join(import.meta.dirname, '../../..');
const presentAtStart = PROXY_ENV_VARS.filter((key) => key in process.env);

afterEach(() => clearProxyEnv(process.env));

describe('host test proxy environment', () => {
  it('vitest.host.config.ts runs host-test-setup.mjs before every test file', () => {
    const setupFiles = [hostConfig.test?.setupFiles ?? []].flat().map((file) => path.resolve(ROOT, file));
    const setup = path.join(ROOT, 'scripts/electron-migration/lib/host-test-setup.mjs');
    expect(setupFiles).toContain(setup);
    expect(existsSync(setup)).toBe(true);
  });

  it('clears exactly PROXY_ENV_KEYS plus NO_PROXY / no_proxy', () => {
    expect([...PROXY_ENV_VARS]).toEqual([...PROXY_ENV_KEYS, 'NO_PROXY', 'no_proxy']);
  });

  it('no proxy variable from the launching shell reaches a host test file', () => {
    expect(presentAtStart).toEqual([]);
  });

  it('setup deletes the variables instead of blanking them', async () => {
    for (const [index, key] of PROXY_ENV_VARS.entries()) {
      process.env[key] = index % 2 === 0 ? 'http://127.0.0.1:9' : '';
    }
    process.env.W09_UNRELATED_ENV = 'kept';
    vi.resetModules();
    await import('./host-test-setup.mjs');
    expect(PROXY_ENV_VARS.filter((key) => key in process.env)).toEqual([]);
    expect(process.env.W09_UNRELATED_ENV).toBe('kept');
    delete process.env.W09_UNRELATED_ENV;
  });

  it('clearProxyEnv only touches the given environment object', () => {
    const env: Record<string, string | undefined> = { HTTPS_PROXY: 'http://proxy:8080', no_proxy: '', PATH: '/bin' };
    clearProxyEnv(env);
    expect(env).toEqual({ PATH: '/bin' });
    expect(Object.keys(env)).toEqual(['PATH']);
  });
});

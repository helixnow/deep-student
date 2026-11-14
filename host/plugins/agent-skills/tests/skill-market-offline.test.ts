/**
 * G1: `skill_market_search {}` with no network through the real `host.invoke`
 * path and the production desktop `ctx.http` (no injected transport; no proxy
 * configured, so the lookup is for clawhub.ai itself).
 *
 * Name resolution is failed at `dns.lookup` the way an offline machine fails it
 * (`EAI_AGAIN`), so the request never leaves the process. Rust maps the reqwest
 * error to `ChatV2Error::IoError` (`skill_market_client.rs:1197-1234,1479-1486`).
 */
import dns from 'node:dns';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createDesktopHttp } from '../../../platform/http/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import plugin from '../index.ts';
import { memorySettings, unavailableStorage } from './platform-stubs.ts';

afterEach(() => { vi.restoreAllMocks(); });

function failNameResolution(): string[] {
  const hosts: string[] = [];
  vi.spyOn(dns, 'lookup').mockImplementation(((hostname: string, ...rest: unknown[]) => {
    hosts.push(hostname);
    const callback = rest[rest.length - 1] as (error: NodeJS.ErrnoException) => void;
    const error: NodeJS.ErrnoException = new Error(`getaddrinfo EAI_AGAIN ${hostname}`);
    error.code = 'EAI_AGAIN';
    error.syscall = 'getaddrinfo';
    process.nextTick(callback, error);
  }) as unknown as typeof dns.lookup);
  return hosts;
}

describe('skill_market_search without network (skill_market_client.rs:1196)', () => {
  it('returns the IO_ERROR envelope within 1s for the minimal IPC arguments', async () => {
    const hosts = failNameResolution();
    const http = createDesktopHttp({ env: {}, platformProxy: async () => null, logger: { info() {}, warn() {} } });
    const host = await createTestHost({ plugins: [pathsPlugin, plugin], provide: { settings: memorySettings(), storage: unavailableStorage(), http } });
    try {
      const started = performance.now();
      const error = await host.invoke('skill_market_search', {}).then(
        value => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`); },
        (reason: unknown) => reason,
      );
      const elapsedMs = performance.now() - started;
      console.log(`[G1] skill_market_search {} offline: ${elapsedMs.toFixed(1)}ms ${String(error)}`);
      expect(error).toBe(JSON.stringify({
        code: 'IO_ERROR',
        message: 'IO error: Community skill marketplace request failed: error sending request for url '
          + '(https://clawhub.ai/api/v1/skills?sort=trending&limit=24&nonSuspiciousOnly=true): getaddrinfo EAI_AGAIN clawhub.ai',
      }));
      expect(elapsedMs).toBeLessThan(1000);
      expect(hosts).toContain('clawhub.ai');
    } finally { await host.dispose(); await http.close(); }
  });
});

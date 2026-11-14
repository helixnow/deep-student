/**
 * The marketplace commands reach clawhub.ai through the host's `ctx.http` (the desktop transport with the reqwest
 * proxy rules), never through the process-wide `fetch`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import type { HttpRequestInit, HttpService } from '../../../platform/http/api.ts';
import plugin from '../index.ts';
import { GLOBAL_MARKET_CACHE } from '../src/skill-market.ts';
import { memorySettings, unavailableStorage } from './platform-stubs.ts';

beforeEach(() => { GLOBAL_MARKET_CACHE.clear(); });
afterEach(() => { vi.restoreAllMocks(); GLOBAL_MARKET_CACHE.clear(); });

const LIST_URL = 'https://clawhub.ai/api/v1/skills?sort=trending&limit=24&nonSuspiciousOnly=true';

function refuseGlobalFetch(): string[] {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
    calls.push(String(input));
    throw new TypeError('process-wide fetch must not be used by the skill marketplace');
  });
  return calls;
}

function recordingHttp(respond: (url: string) => Response) {
  const calls: Array<{ url: string; init: HttpRequestInit }> = [];
  const http: HttpService = {
    async fetch(input, init = {}) { calls.push({ url: String(input), init }); return respond(String(input)); },
    async fetchBytes() { throw new Error('fetchBytes is not used by the skill marketplace'); },
    async isPublicUrl() { return true; },
    async checkPublicPinned() { throw new Error('checkPublicPinned is not used by the skill marketplace'); },
  } as HttpService;
  return { http, calls };
}

describe('skill marketplace transport', () => {
  it('skill_market_search sends every request through ctx.http with the Rust client policy', async () => {
    const globalCalls = refuseGlobalFetch();
    const listing = JSON.stringify({ items: [{ slug: 'demo', displayName: 'Demo', latestVersion: { version: '1.0.0' } }] });
    const verdicts = JSON.stringify({ items: [] });
    const { http, calls } = recordingHttp(url => new Response(url.includes('security-verdicts') ? verdicts : listing,
      { status: 200, headers: { 'content-type': 'application/json' } }));
    const host = await createTestHost({ plugins: [pathsPlugin, plugin], provide: { settings: memorySettings(), storage: unavailableStorage(), http } });
    try {
      const result = await host.invoke('skill_market_search', {}) as { mode: string; items: Array<{ slug: string; version: string }> };
      expect(result).toMatchObject({ mode: 'list', items: [{ slug: 'demo', version: '1.0.0' }] });
      expect(calls.map(call => call.url)).toEqual([LIST_URL, 'https://clawhub.ai/api/v1/skills/-/security-verdicts']);
      expect(calls[0]!.init).toMatchObject({ method: 'GET', destination: 'any', redirect: 'manual', headers: { 'user-agent': 'DeepStudent-SkillMarket/1.0' } });
      expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
      expect(calls[1]!.init).toMatchObject({
        method: 'POST', destination: 'any', redirect: 'manual',
        headers: { 'user-agent': 'DeepStudent-SkillMarket/1.0', 'content-type': 'application/json' },
        body: JSON.stringify({ items: [{ slug: 'demo', version: '1.0.0' }] }),
      });
      expect(globalCalls).toEqual([]);
    } finally { await host.dispose(); }
  });

  it('a host without ctx.http refuses with UNSUPPORTED_ON_PLATFORM instead of opening its own connection', async () => {
    const globalCalls = refuseGlobalFetch();
    const host = await createTestHost({ plugins: [pathsPlugin, plugin], provide: { settings: memorySettings(), storage: unavailableStorage() } });
    try {
      const error = await host.invoke('skill_market_search', {}).then(
        value => { throw new Error(`expected rejection, got ${JSON.stringify(value)}`); },
        (reason: unknown) => String(reason),
      );
      expect(error).toBe(JSON.stringify({
        code: 'IO_ERROR',
        message: 'IO error: UNSUPPORTED_ON_PLATFORM: the community skill marketplace needs the ctx.http service, which this host does not provide',
      }));
      expect(globalCalls).toEqual([]);
    } finally { await host.dispose(); }
  });
});

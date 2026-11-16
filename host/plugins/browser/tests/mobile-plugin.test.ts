import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';
import browserMobile, {
  BROWSER_PORTABLE_COMMANDS,
  BROWSER_UNSUPPORTED_COMMANDS,
} from '../mobile.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const hosts: TestHost[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const host of hosts.splice(0)) await host.dispose();
});

function rssPayload(): Response {
  return new Response(
    '<?xml version="1.0"?><rss><channel><item><title>Portable Search</title><link>https://example.com/1</link><description>Match</description></item></channel></rss>',
    { status: 200 },
  );
}

async function setupMobileBrowser(options: {
  settings?: Record<string, string>;
  httpFetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
} = {}) {
  const values = new Map(Object.entries(options.settings ?? {}));
  const host = await createTestHost({
    plugins: [browserMobile],
    provide: {
      settings: {
        get: (key: string) => values.get(key) ?? null,
        save: (key: string, value: string) => { values.set(key, value); },
        getSecret: async (key: string) => values.get(key) ?? null,
        saveSecret: async (key: string, value: string) => { values.set(key, value); },
        deleteSecret: async (key: string) => values.delete(key),
      },
      log: { logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
      ...(options.httpFetch ? { http: { fetch: options.httpFetch } } : {}),
    },
  });
  hosts.push(host);
  return { host, values };
}

describe('dstu.browser mobile plugin', () => {
  it('declares mobile platform and portable closure contains zero Node dependencies', () => {
    expect(browserMobile.meta.platforms).toEqual(['mobile']);
    expect(browserMobile.meta.provides).toEqual([
      'llmWebSearchFallback',
      'browserToolPolicy',
      'webpageToolPolicy',
    ]);
    expect(browserMobile.meta.commands).toEqual([...BROWSER_PORTABLE_COMMANDS, ...BROWSER_UNSUPPORTED_COMMANDS]);
    expect(checkModulesClosure(ROOT, ['host/plugins/browser/mobile.ts'])).toEqual([]);
  });

  it('routes network_probe through ctx.http.fetch (search test commands live in dstu.mobile.web-search)', async () => {
    const visited: string[] = [];
    const { host } = await setupMobileBrowser({
      httpFetch: async (input, init) => {
        const url = String(input);
        visited.push(`${init?.method ?? 'GET'} ${url}`);
        if (url.startsWith('https://probe.example.com/')) {
          return new Response(null, { status: 204 });
        }
        return rssPayload();
      },
    });

    expect(await host.invoke('network_probe', { url: 'https://probe.example.com/health', timeoutMs: 2000 }))
      .toMatchObject({ ok: true, statusCode: 204, error: null });

    expect(browserMobile.meta.commands).not.toContain('test_search_engine');
    expect(visited[0]).toBe('HEAD https://probe.example.com/health');
  });

  it('rejects non-http network_probe URLs', async () => {
    const { host } = await setupMobileBrowser();
    await expect(host.invoke('network_probe', { url: 'ftp://example.com' }))
      .resolves.toMatchObject({
        ok: false,
        statusCode: null,
        error: expect.stringContaining('unknown scheme'),
      });
  });

  it('provides a working llmWebSearchFallback service', async () => {
    const { host } = await setupMobileBrowser({
      settings: { 'session.selected_search_engines': 'bing_rss' },
      httpFetch: async () => rssPayload(),
    });
    const fallback = await host.ctx.llmWebSearchFallback.call({
      window: null,
      streamEvent: 'chat',
      memoryEnabled: false,
      args: { query: 'fallback test', top_k: 2 },
    });
    expect(fallback.ok).toBe(true);
    expect(fallback.citations?.length).toBe(1);
  });

  it('marks desktop browser_* commands as UNSUPPORTED_ON_PLATFORM', async () => {
    const { host } = await setupMobileBrowser();
    const sampleArgs: Record<string, Record<string, unknown>> = {
      browser_open_session: { url: 'https://example.com' },
      browser_navigate: { sessionId: 's1', url: 'https://example.com' },
      browser_back: { sessionId: 's1' },
      browser_forward: { sessionId: 's1' },
      browser_reload: { sessionId: 's1' },
      browser_release_surface_focus: { sessionId: 's1' },
      browser_set_surface_bounds: {
        sessionId: 's1',
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        viewportWidth: 800,
        viewportHeight: 600,
        sequence: 1,
      },
      browser_set_surface_visibility: { sessionId: 's1', visible: true },
      browser_content_user_input: { sessionId: 's1', nonce: 'n', kind: 'click' },
      browser_snapshot: { sessionId: 's1' },
      browser_click: { sessionId: 's1', ref: '@e1' },
      browser_type: { sessionId: 's1', ref: '@e1', text: 'hi' },
      browser_set_input_files: { sessionId: 's1', ref: '@e1', files: [] },
      browser_list_downloads: { sessionId: 's1' },
      browser_list_task_downloads: { chatSessionId: 'c1' },
      browser_scroll: { sessionId: 's1' },
    };
    for (const cmd of BROWSER_UNSUPPORTED_COMMANDS) {
      await expect(host.invoke(cmd, sampleArgs[cmd] ?? {})).rejects.toMatch(/^UNSUPPORTED_ON_PLATFORM:/);
    }
  });
});

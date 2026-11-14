import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { ExecutionContext, ToolResultInfo } from '../../chat/api.ts';
import { FetchChatToolExecutor } from '../src/tools/fetch-chat-executor.ts';
import { page, pinnedHttp } from './web-fetch-transport.ts';

const PUBLIC = '93.184.216.34';
type Answers = (host: string, call: number) => string[];

/** Resolver answers per host and call count; every connection is recorded as `url @ address`. */
function harness(answers: Answers, pages: Record<string, { status: number; location?: string; body?: string }>) {
  const lookups: string[] = [];
  const connections: string[] = [];
  const http = pinnedHttp(async host => {
    lookups.push(host);
    const call = lookups.filter(entry => entry === host).length;
    return answers(host, call).map(address => ({ address }));
  }, ({ url, address }) => {
    connections.push(`${url.href} @ ${address}`);
    return page((pages[url.href] ?? { status: 404 }).status, pages[url.href] ?? {});
  });
  const executor = new FetchChatToolExecutor({
    settings: () => null, artifactRoot: sessionId => path.join(tmpdir(), 's01-dns', sessionId),
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    http: () => http, files: () => null,
  });
  const ctx = { session_id: 's', block_id: 'b', cancellation_token: null, isCancelled: () => false,
    emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined, emitToolCallError: () => undefined,
    saveToolBlock: () => undefined } as unknown as ExecutionContext;
  const run = (url: string): Promise<ToolResultInfo> => executor.execute({ id: 'c', name: 'web_fetch', arguments: { url } }, ctx);
  return { run, lookups, connections };
}

describe('RF-S01-web-fetch-resolved-loopback-blocked', () => {
  it('RF-S01-web-fetch-resolved-loopback-blocked: a name that resolves to loopback is refused before any connection', async () => {
    for (const answer of [['127.0.0.1'], ['::1'], ['::ffff:127.0.0.1'], [PUBLIC, '127.0.0.1']]) {
      const h = harness(() => answer, {});
      const result = await h.run('http://127.0.0.1.nip.io:11434/api/tags');
      expect([answer, result.error]).toEqual([answer, 'Blocked: URL resolves to internal IP address']);
      expect(h.connections).toEqual([]);
    }
  });

  it('RF-S01-web-fetch-resolved-loopback-blocked: URLs that name this machine (approval required) still reach it', async () => {
    for (const url of ['http://localhost:3000/health', 'http://127.0.0.1:3000/health', 'http://[::1]:3000/health']) {
      const h = harness(() => ['127.0.0.1'], { [url]: { status: 200, body: 'local ok' } });
      expect(await h.run(url)).toMatchObject({ success: true, output: { content: 'local ok' } });
    }
  });

  it('RF-S01-web-fetch-resolved-loopback-blocked: a redirect to a name resolving to loopback stops on the 3xx', async () => {
    const h = harness(host => (host === 'public.test' ? [PUBLIC] : ['127.0.0.1']), {
      'http://public.test/go': { status: 302, location: 'http://evil.test:8080/admin' },
      'http://evil.test:8080/admin': { status: 200, body: 'local admin' },
    });
    expect((await h.run('http://public.test/go')).error).toBe('HTTP request failed with status 302: Found');
    expect(h.connections).toEqual([`http://public.test/go @ ${PUBLIC}`]);
  });
});

describe('RF-S01-web-fetch-dns-pinning', () => {
  const rebinding: Answers = (_host, call) => (call === 1 ? [PUBLIC] : ['127.0.0.1']);

  it('RF-S01-web-fetch-dns-pinning: the connection uses the validated answer and the name is resolved once', async () => {
    const h = harness(rebinding, { 'http://rebind.test/page': { status: 200, body: 'public page' } });
    // Rust validates the first answer, then reqwest and validate_public_url_target resolve again and see 127.0.0.1.
    expect(await h.run('http://rebind.test/page')).toMatchObject({ success: true, output: { content: 'public page' } });
    expect(h.connections).toEqual([`http://rebind.test/page @ ${PUBLIC}`]);
    expect(h.lookups).toEqual(['rebind.test']);
  });

  it('RF-S01-web-fetch-dns-pinning: each redirect hop connects to the address its own check accepted', async () => {
    const h = harness(rebinding, {
      'http://start.test/go': { status: 302, location: 'http://hop.test/page' },
      'http://hop.test/page': { status: 200, body: 'hop page' },
    });
    expect(await h.run('http://start.test/go')).toMatchObject({ success: true, output: { content: 'hop page', redirected: true } });
    expect(h.connections).toEqual([`http://start.test/go @ ${PUBLIC}`, `http://hop.test/page @ ${PUBLIC}`]);
    expect(h.lookups).toEqual(['start.test', 'hop.test']);
  });

  it('RF-S01-web-fetch-dns-pinning: the final-URL check judges the pinned address, so a later DNS failure cannot fail a completed fetch', async () => {
    const h = harness((_host, call) => {
      if (call > 1) throw new Error('resolver is gone');
      return [PUBLIC];
    }, { 'http://flaky.test/page': { status: 200, body: 'done' } });
    expect(await h.run('http://flaky.test/page')).toMatchObject({ success: true, output: { content: 'done' } });
  });
});

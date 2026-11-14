import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../../chat/api.ts';
import { FetchChatToolExecutor, namesLoopback } from '../src/tools/fetch-chat-executor.ts';
import { page, pinnedHttp } from './web-fetch-transport.ts';

const ID = 'RF-S01-web-fetch-loopback-approval';
const DNS: Record<string, string[]> = { 'public.test': ['93.184.216.34'], 'loop.test': ['127.0.0.1'], localhost: ['127.0.0.1'] };
const PAGES: Record<string, { status: number; location?: string; body?: string }> = {
  'http://public.test/to-local': { status: 302, location: 'http://127.0.0.1:11434/api/tags' },
  'http://public.test/to-named-local': { status: 302, location: 'http://loop.test:8080/admin' },
  'http://public.test/to-public': { status: 302, location: 'http://public.test/page' },
  'http://public.test/page': { status: 200, body: 'public page' },
  'http://localhost:3000/to-local': { status: 302, location: 'http://127.0.0.1:3000/health' },
  'http://127.0.0.1:3000/health': { status: 200, body: 'local ok' },
  'http://127.0.0.1:11434/api/tags': { status: 200, body: 'local model list' },
  'http://loop.test:8080/admin': { status: 200, body: 'local admin' },
};

function harness() {
  const connections: string[] = [];
  const http = pinnedHttp(async host => (DNS[host] ?? []).map(address => ({ address })), ({ url, address }) => {
    connections.push(`${url.href} @ ${address}`);
    return page((PAGES[url.href] ?? { status: 404 }).status, PAGES[url.href] ?? {});
  });
  const executor = new FetchChatToolExecutor({
    settings: () => null, artifactRoot: sessionId => path.join(tmpdir(), 's01-loopback', sessionId),
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    http: () => http, files: () => null,
  });
  const ctx = { session_id: 's', block_id: 'b', cancellation_token: null, isCancelled: () => false,
    emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined, emitToolCallError: () => undefined,
    saveToolBlock: () => undefined } as unknown as ExecutionContext;
  const run = (url: string) => executor.execute({ id: 'c', name: 'builtin-web_fetch', arguments: { url } }, ctx);
  return { executor, run, connections };
}

describe(ID, () => {
  it('RF-S01-web-fetch-loopback-approval: a URL naming this machine needs approval (high); other URLs stay low', () => {
    const { executor } = harness();
    for (const url of ['http://localhost:11434/', 'http://LOCALHOST/', 'http://api.localhost/', 'http://127.0.0.1:8080/',
      'http://127.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://[::1]:3000/', 'http://[::ffff:127.0.0.1]/']) {
      expect([url, executor.sensitivityLevelForCall('web_fetch', { url })]).toEqual([url, 'high']);
    }
    for (const url of ['https://example.com/', 'http://loop.test/', 'http://localhost.example.com/', 'not a url']) {
      expect([url, executor.sensitivityLevelForCall('web_fetch', { url })]).toEqual([url, 'low']);
    }
    expect(executor.sensitivityLevelForCall('web_fetch', {})).toBe('low');
    expect(executor.sensitivityLevel('web_fetch')).toBe('low');
    expect(executor.hasDynamicSensitivity('web_fetch')).toBe(true);
    expect(namesLoopback('http://[::1]/')).toBe(true);
  });

  it('RF-S01-web-fetch-loopback-approval: a public page cannot redirect web_fetch into loopback (Rust followed it with a low-risk approval)', async () => {
    for (const target of ['http://public.test/to-local', 'http://public.test/to-named-local']) {
      const h = harness();
      const result = await h.run(target);
      expect(h.connections).toEqual([`${target} @ 93.184.216.34`]);
      for (const body of ['local model list', 'local admin']) expect(JSON.stringify(result)).not.toContain(body);
    }
  });

  it('RF-S01-web-fetch-loopback-approval: public→public and approved loopback→loopback redirects still follow', async () => {
    const pub = harness();
    expect(await pub.run('http://public.test/to-public')).toMatchObject({ success: true, output: { content: 'public page', redirected: true } });
    const local = harness();
    expect(await local.run('http://localhost:3000/to-local')).toMatchObject({ success: true, output: { content: 'local ok', redirected: true } });
    expect(local.connections).toEqual(['http://localhost:3000/to-local @ 127.0.0.1', 'http://127.0.0.1:3000/health @ 127.0.0.1']);
  });
});

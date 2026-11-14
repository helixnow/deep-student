/**
 * http / opener：构造时的作用域是全部 capability 的并集，每次调用还要落在调用方经 ACL 解析出的作用域内
 * （`CommandContext.scope`）；没有调用作用域时一律拒绝。
 */
import { describe, expect, it } from 'vitest';
import type { ScopeEntries } from '../shell/capabilities.ts';
import { httpPlugin } from '../shell/plugins/http.ts';
import { openerPlugin } from '../shell/plugins/system.ts';
import type { CommandContext } from '../shell/runtime.ts';
import { FsScope } from '../shell/scope.ts';

function context(scope: ScopeEntries | null): CommandContext {
  let rid = 0;
  return {
    webviewLabel: 'main',
    runtime: {
      windows: { get: () => undefined },
      addResource: () => (rid += 1),
      paths: { parseVariablePath: (path: string) => path },
    },
    ...(scope === null ? {} : { scope: () => scope }),
  } as unknown as CommandContext;
}

const fetchInput = (url: string) => ({ command: 'fetch', json: { clientConfig: { method: 'GET', url, headers: [] } }, raw: null, headers: {} });

describe('per-call scopes of the http and opener plugins', () => {
  it('plugin:http|fetch must match both the capability union and the caller scope', () => {
    const plugin = httpPlugin({ allow: ['https://*/*', 'http://localhost:*/*'], deny: [] });
    const caller = context({ allow: [{ url: 'https://api.example/*' }], deny: [{ url: 'https://api.example/private/*' }] });
    expect(plugin.fetch!(fetchInput('https://api.example/v1/chat'), caller)).toBe(1);
    expect(() => plugin.fetch!(fetchInput('https://other.example/'), caller)).toThrow('url not allowed on the configured scope: https://other.example/');
    expect(() => plugin.fetch!(fetchInput('https://api.example/private/keys'), caller)).toThrow('url not allowed on the configured scope');
    expect(() => plugin.fetch!(fetchInput('http://localhost:8080/'), caller)).toThrow('url not allowed on the configured scope');
    expect(() => plugin.fetch!(fetchInput('https://api.example/v1/chat'), context(null))).toThrow('url not allowed on the configured scope');
    const outsideUnion = context({ allow: [{ url: 'http://*/*' }], deny: [] });
    expect(() => plugin.fetch!(fetchInput('http://intranet.example/'), outsideUnion)).toThrow('url not allowed on the configured scope');
  });

  it('plugin:opener|open_url and open_path are refused outside the caller scope before reaching the OS', async () => {
    const paths = new FsScope({ platform: 'linux' });
    paths.allowPattern('/data/**');
    const plugin = openerPlugin({ urlAllow: [{ url: 'https://*', app: null }, { url: 'mailto:*', app: null }], paths, pathApps: [null] }, 'linux');
    const caller = context({ allow: [{ url: 'mailto:*' }, { path: '/data/docs/**' }], deny: [] });
    const run = (command: 'open_url' | 'open_path', json: unknown, ctx: CommandContext) =>
      Promise.resolve().then(() => plugin[command]!({ command, json, raw: null, headers: {} }, ctx));
    await expect(run('open_url', { url: 'https://evil.example/' }, caller)).rejects.toThrow('Not allowed to open url https://evil.example/');
    await expect(run('open_url', { url: 'https://evil.example/' }, context(null))).rejects.toThrow('Not allowed to open url');
    await expect(run('open_path', { path: '/data/other/file.pdf' }, caller)).rejects.toThrow('Not allowed to open path /data/other/file.pdf');
    await expect(run('open_path', { path: '/data/docs/file.pdf' }, context(null))).rejects.toThrow('Not allowed to open path');
  });
});

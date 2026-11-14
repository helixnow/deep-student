import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import type { CommandContext, Resource } from '../shell/runtime.ts';
import { updaterPlugin } from '../shell/updater.ts';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error ? reject(error) : resolve()));
  })));
});

interface Seen { url: string | undefined; headers: IncomingHttpHeaders }

async function serve(version: () => string): Promise<{ base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url, headers: request.headers });
    if (request.url === '/latest.json') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version: version(), url: `${base}/pkg`, signature: 'c2ln' }));
    } else {
      response.writeHead(200).end('package');
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, seen };
}

function context(endpoint: string): CommandContext {
  const resources = new Map<number, Resource>();
  return {
    webviewLabel: 'main',
    runtime: {
      platform: 'linux',
      debug: true,
      config: { version: '1.0.0', updater: { endpoints: [endpoint], pubkey: 'unused' } },
      addResource: (_label: string, resource: Resource) => { resources.set(resources.size + 1, resource); return resources.size; },
      getResource: (_label: string, rid: number) => resources.get(rid),
      sendChannel: () => undefined,
    },
  } as unknown as CommandContext;
}

const app = { appName: 'DeepStudent', execPath: '/tmp/DeepStudent', argv: [], env: {}, exit: () => undefined };
const input = (command: string, json: unknown) => ({ command, json, raw: null, headers: {} });

it('RF-W23-updater-ignore-page-options: check ignores page allowDowngrades, proxy and headers', async () => {
  const proxy = await serve(() => '0.0.1');
  const updates = await serve(() => '0.9.0');
  const plugin = updaterPlugin(app);
  const ctx = context(`${updates.base}/latest.json`);
  const page = { allowDowngrades: true, proxy: proxy.base, headers: [['x-page', 'evil'], ['authorization', 'Bearer page']] };
  expect(await plugin.check!(input('check', page), ctx)).toBeNull();
  expect(updates.seen).toHaveLength(1);
  expect(updates.seen[0]!.headers).not.toHaveProperty('x-page');
  expect(updates.seen[0]!.headers).not.toHaveProperty('authorization');
  expect(proxy.seen).toEqual([]);
});

it('RF-W23-updater-ignore-page-options: download and download_and_install ignore page headers', async () => {
  const updates = await serve(() => '2.0.0');
  const plugin = updaterPlugin(app);
  const ctx = context(`${updates.base}/latest.json`);
  const checked = await plugin.check!(input('check', { headers: [['x-page', 'check']] }), ctx) as { rid: number; version: string };
  expect(checked.version).toBe('2.0.0');
  for (const command of ['download', 'download_and_install'] as const) {
    await expect(Promise.resolve().then(() => plugin[command]!(input(command, { rid: checked.rid, onEvent: '__CHANNEL__:1', headers: [['x-page', command]] }), ctx))).rejects.toThrow();
  }
  const downloads = updates.seen.filter((entry) => entry.url === '/pkg');
  expect(downloads).toHaveLength(2);
  for (const entry of updates.seen) expect(entry.headers).not.toHaveProperty('x-page');
});

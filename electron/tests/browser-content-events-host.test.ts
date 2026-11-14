/**
 * 真实 Electron：browser-content 的页面完成与 `document.title` 变化按 Rust `ContentWindowHooks` 的语义转发
 * （`on_page_load(Finished)` 只在成功时、SPA 路由只有标题事件、合成标题与失败加载不转发）。
 * fixture 见 `fixtures/browser-content-events-main.ts`。
 */
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { spawnElectron } from './electron-process.ts';
import { PAGE_FINISHED_EVENT, TITLE_CHANGED_EVENT } from '../shell/browser-content-events.ts';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no local port');
  return address.port;
}

describe('browser-content page events (real Electron)', () => {
  const servers: Server[] = [];
  afterAll(() => {
    for (const server of servers) server.close();
  });

  it('forwards finished loads and explicit title changes with the current URL', async () => {
    const pages: Record<string, string> = {
      '/titled': '<!doctype html><html><head><title>One</title></head><body>one</body></html>',
      '/untitled': '<!doctype html><html><body>no title</body></html>',
      '/link': '<!doctype html><html><head><title>Link</title></head><body><a id="next" href="/next">next</a></body></html>',
      '/next': '<!doctype html><html><head><title>Next</title></head><body>next</body></html>',
    };
    const server = createServer((request, response) => {
      const body = pages[request.url ?? ''];
      response.writeHead(body === undefined ? 404 : 200, { 'Content-Type': 'text/html' });
      response.end(body ?? 'missing');
    });
    const closed = createServer();
    servers.push(server);
    const port = await listen(server);
    const refusedPort = await listen(closed);
    await new Promise((resolve) => closed.close(resolve));
    const base = `http://127.0.0.1:${port}`;

    const child = await spawnElectron(createRequire(import.meta.url)('electron') as string, [join(import.meta.dirname, 'fixtures/browser-content-events-main.ts')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', EVENTS_ORIGIN: base, EVENTS_REFUSED: `http://127.0.0.1:${refusedPort}/` },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    const exitCode = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 40_000);
      child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
    expect(exitCode, output).toBe(0);
    const line = output.split('\n').find((entry) => entry.startsWith('RESULT '));
    expect(line, output).toBeDefined();
    const results = JSON.parse(line!.slice('RESULT '.length)) as Record<string, unknown>;

    const title = (text: string, path: string) => [TITLE_CHANGED_EVENT, { title: text, url: `${base}${path}` }];
    const finished = (path: string) => [PAGE_FINISHED_EVENT, { url: `${base}${path}` }];
    expect(results).toEqual({
      titled: [title('One', '/titled'), finished('/titled')],
      scriptTitle: [title('Changed by script', '/titled')],
      // pushState 不是页面加载：与 wry 一样只有标题事件，插件据其携带的 URL 识别 SPA 导航。
      spa: [title('SPA route', '/spa-route')],
      // 没有 <title>：Chromium 用 URL 合成的标题不转发。
      untitled: [finished('/untitled')],
      linkClick: [title('Next', '/next'), finished('/next')],
      // 连接失败：Chromium 提交错误页，但没有成功的页面完成，也不转发错误页标题。
      failed: [],
      afterFailure: [title('One', '/titled'), finished('/titled')],
    });
  }, 60_000);
});

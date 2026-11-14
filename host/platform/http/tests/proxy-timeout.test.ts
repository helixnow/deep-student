/**
 * 代理客户端的总超时：默认取构造时的 reqwest 配置（300 s），`requestTimeoutMs` 数字覆盖它，`null` 表示不设总超时
 * （W04 的 `question-import-vision` 长文档流式请求只靠自己的空闲看门狗）。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProxyHttpClient, type ProxyHttpClient, type ProxyRequestInit } from '../proxy.ts';

let server: Server;
let url: string;
let client: ProxyHttpClient;

beforeEach(async () => {
  server = createServer((request, response) => {
    if (request.url === '/hang') { response.writeHead(200); response.write('partial'); return; }
    response.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  client = createProxyHttpClient({}, { platformProxy: async () => null, logger: { info: () => {}, warn: () => {} } });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await client.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('createProxyHttpClient total timeout', () => {
  it('defaults to the client-wide 300 s timeout and lets a number override it', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    expect(await (await client.fetch(url)).text()).toBe('ok');
    expect(timeout).toHaveBeenLastCalledWith(300_000);
    expect(await (await client.fetch(url, { requestTimeoutMs: 1234 } as ProxyRequestInit)).text()).toBe('ok');
    expect(timeout).toHaveBeenLastCalledWith(1234);
    expect(timeout).toHaveBeenCalledTimes(2);
  });

  it('requestTimeoutMs: null sends without a total timeout; the caller signal still aborts', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    expect(await (await client.fetch(url, { requestTimeoutMs: null } as ProxyRequestInit)).text()).toBe('ok');
    expect(timeout).not.toHaveBeenCalled();

    const controller = new AbortController();
    const response = await client.fetch(`${url}/hang`, { requestTimeoutMs: null, signal: controller.signal } as ProxyRequestInit);
    const body = response.text();
    controller.abort(new Error('idle watchdog'));
    await expect(body).rejects.toThrow('idle watchdog');
    expect(timeout).not.toHaveBeenCalled();
  });

  it('a short numeric timeout still cuts a hanging body', async () => {
    await expect((async () => (await client.fetch(`${url}/hang`, { requestTimeoutMs: 50 } as ProxyRequestInit)).text())())
      .rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

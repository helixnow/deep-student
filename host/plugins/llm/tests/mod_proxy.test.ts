import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLlmHttpClient, proxyUrlFor, type LlmRequestInit } from '../src/http_proxy.ts';
import { createLlmStreamingService } from '../src/streaming_service.ts';
import { OpenAIAdapter } from '../../llm-providers/api.ts';
import { defaultSingleShotOptions } from '../api.ts';
import { makeConfig } from './support.ts';

describe('llm_manager/mod.rs', () => {
  it('honors per-request deadlines instead of imposing the shared 300-second timeout', async () => {
    const server = createServer((_request, response) => { response.writeHead(200); response.write('body'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = createLlmHttpClient({});
    try {
      const init: LlmRequestInit = { requestTimeoutMs: 50 };
      await expect((async () => {
        const response = await client.fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, init);
        return response.text();
      })()).rejects.toThrow();
    } finally {
      await client.close(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it('http_client_honors_proxy_environment', async () => {
    const seen: string[] = [];
    const server = createServer((request, response) => {
      seen.push(`${request.method ?? ''} ${request.url ?? ''}`);
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': '2',
      });
      response.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as AddressInfo;
      const proxyUrl = `http://127.0.0.1:${address.port}`;
      const env = {
        HTTP_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        https_proxy: proxyUrl,
        ALL_PROXY: proxyUrl,
        all_proxy: proxyUrl,
        NO_PROXY: 'localhost,::1',
        no_proxy: 'localhost,::1',
      };
      expect(proxyUrlFor('http://proxy-verify.invalid/v1/models', env)).toBe(proxyUrl);
      const client = createLlmHttpClient(env);
      try {
        const result = await client.fetch('http://proxy-verify.invalid/v1/models');
        expect(result.status).toBe(200);
        expect(await result.text()).toBe('{}');
      } finally { await client.close(); }
      expect(seen[0]?.startsWith('GET http://proxy-verify.invalid')).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('routes the streaming production transport through the proxy and honors NO_PROXY', async () => {
    const seen: string[] = [];
    const proxy = createServer((request, response) => {
      seen.push(`${request.method} ${request.url}`);
      expect(request.headers['accept-encoding']).toBe('identity');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"choices":[{"delta":{"content":"proxied"}}]}\n\ndata: [DONE]\n\n');
    });
    const direct = createServer((_request, response) => response.end('direct'));
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    await new Promise<void>(resolve => direct.listen(0, '127.0.0.1', resolve));
    const client = createLlmHttpClient({ HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, NO_PROXY: '127.0.0.1' });
    try {
      const service = createLlmStreamingService({ createAdapter: () => new OpenAIAdapter() }, client.fetch);
      const result = await service.singleShotCompletion(makeConfig({ baseUrl: 'http://stream.invalid/v1' }),
        { messages: [{ role: 'user', content: 'hello' }] }, 'key', null, 'build', defaultSingleShotOptions('proxy'));
      expect(result.content).toBe('proxied');
      const response = await client.fetch(`http://127.0.0.1:${(direct.address() as AddressInfo).port}`);
      expect(await response.text()).toBe('direct');
      expect(seen).toEqual(['POST http://stream.invalid/v1/chat/completions']);
    } finally {
      await client.close();
      await Promise.all([proxy, direct].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    }
  });

  it('uses CONNECT for HTTPS without disabling certificate validation', async () => {
    const proxy = createServer();
    let authority = '';
    proxy.on('connect', (request, socket) => {
      authority = request.url ?? '';
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const client = createLlmHttpClient({ HTTPS_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` });
    try {
      await expect(client.fetch('https://secure.invalid/v1/models')).rejects.toThrow();
      expect(authority).toBe('secure.invalid:443');
    } finally {
      await client.close();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
  });

  it('follows at most ten redirects as reqwest does and strips POST bodies on 302', async () => {
    const seen: string[] = [];
    const server = createServer((request, response) => {
      seen.push(request.method ?? '');
      response.writeHead(302, { location: `/${Number((request.url ?? '/0').slice(1)) + 1}` });
      response.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = createLlmHttpClient({});
    try {
      await expect(client.fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/0`, { method: 'POST', body: '{}' })).rejects.toThrow('too many redirects');
      expect(seen).toHaveLength(10);
      expect(seen[0]).toBe('POST');
      expect(seen.slice(1).every(method => method === 'GET')).toBe(true);
    } finally {
      await client.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

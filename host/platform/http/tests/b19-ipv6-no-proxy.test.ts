import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createProxyHttpClient, proxyUrlFor } from '../proxy.ts';

describe('IPv6 local model endpoints bypass the proxy', () => {
  it.each(['::1', '[::1]', '[::1]:11434'])('matches NO_PROXY=%s', entry => {
    expect(proxyUrlFor('http://[::1]:11434/v1/models', {
      HTTP_PROXY: 'http://127.0.0.1:7890', NO_PROXY: entry,
    })).toBeNull();
  });

  it('keeps port-specific bypasses restricted to that port', () => {
    expect(proxyUrlFor('http://[::1]:11435/v1/models', {
      HTTP_PROXY: 'http://127.0.0.1:7890', NO_PROXY: '[::1]:11434',
    })).toBe('http://127.0.0.1:7890');
  });

  it('sends a real IPv6 loopback request directly, not to the configured proxy', async () => {
    let proxyRequests = 0;
    const proxy = createServer((_request, response) => { proxyRequests++; response.end('proxy'); });
    const target = createServer((_request, response) => response.end('local model'));
    const close = (server: Server) => new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        target.once('error', reject);
        target.listen(0, '::1', resolve);
      });
      const client = createProxyHttpClient({
        HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, NO_PROXY: 'localhost,::1',
      }, { logger: { info() {}, warn() {} } });
      try {
        const response = await client.fetch(`http://[::1]:${(target.address() as AddressInfo).port}/v1/models`);
        expect(await response.text()).toBe('local model');
        expect(proxyRequests).toBe(0);
      } finally {
        await client.close();
      }
    } finally {
      await Promise.all([close(target), close(proxy)]);
    }
  });
});

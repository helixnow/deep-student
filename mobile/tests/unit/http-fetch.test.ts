import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithTimeout } from '../../src/shell/http-fetch.ts';

afterEach(() => { vi.unstubAllGlobals(); });

describe('WebView HTTP fallback deadline', () => {
  it('aborts a fetch that never produces headers', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    })));
    await expect(fetchWithTimeout('https://example.com', {}, 10)).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('keeps the timeout active while the response body is still streaming', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
      },
    }))));
    const response = await fetchWithTimeout('https://example.com', {}, 10);
    await expect(response.arrayBuffer()).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it.each([null, undefined, 0])('does not impose a deadline for %s', async timeout => {
    const fetcher = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetcher);
    await fetchWithTimeout('https://example.com', { method: 'POST', body: 'test' }, timeout);
    expect(fetcher).toHaveBeenCalledWith('https://example.com', { method: 'POST', body: 'test' });
  });
});

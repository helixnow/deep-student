import { afterEach, expect, it, vi } from 'vitest';
import { fetchBinaryWithCache } from '../node.ts';

afterEach(() => vi.restoreAllMocks());

it.each([302, 404, 503])('releases the unread body for rejected image status %s', async status => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }), { status });
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);

  expect(await fetchBinaryWithCache(`http://127.0.0.1/image-status-${status}`)).toBeNull();
  expect(cancel).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: 'manual' }));
});

it.each(['pending', 'failed'])('does not wait for %s rejected-response cleanup', async cleanup => {
  const cancel = vi.fn(() => cleanup === 'pending' ? new Promise<void>(() => {}) : Promise.reject(new Error('cleanup failed')));
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 404 }));

  expect(await fetchBinaryWithCache(`http://127.0.0.1/image-cleanup-${cleanup}`)).toBeNull();
  expect(cancel).toHaveBeenCalledOnce();
});

it('still consumes and caches successful image bytes', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); },
    cancel,
  });
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { headers: { 'content-type': 'image/png' } }));
  const url = 'http://127.0.0.1/image-cleanup-success';

  expect(await fetchBinaryWithCache(url)).toEqual({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' });
  expect(await fetchBinaryWithCache(url)).toEqual({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(cancel).not.toHaveBeenCalled();
});

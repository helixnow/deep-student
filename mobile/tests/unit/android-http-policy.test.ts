import { expect, it, vi } from 'vitest';
import { createMobileHttp, type MobileHttpShell } from '../../../host/platform/http/mobile.ts';

it('validates every native DNS answer, pins each redirect, and cancels when a decoded body exceeds the caller limit', async () => {
  const opens: { url: string; headers: Record<string, string>; address?: Uint8Array }[] = [];
  const closed: string[] = [];
  let reads = 0;
  const request = vi.fn(async (op: string, args?: unknown) => {
    if (op === 'http.android.available') return true;
    if (op === 'http.android.resolve') {
      const { host } = args as { host: string };
      return { addresses: host === 'mixed.example' ? ['93.184.216.34', '::ffff:10.0.0.5']
        : [host === 'first.example' ? '93.184.216.34' : '93.184.216.35'] };
    }
    const input = args as (typeof opens)[number] & { id: string };
    if (op === 'http.android.open') {
      opens.push(input);
      return { url: input.url, status: input.url.includes('first.example') ? 302 : 200,
        headers: input.url.includes('first.example') ? { location: 'https://second.example/data' } : {} };
    }
    if (op === 'http.android.read') { reads++; return { done: false, bytes: Uint8Array.from([1, 2, 3]) }; }
    if (op === 'http.android.cancel') { closed.push(input.id); return null; }
    throw new Error(`unexpected ${op}`);
  });
  const web = vi.fn(async () => { throw new Error('pinned requests cannot use Worker fetch'); });
  const http = createMobileHttp({ transport: web, shell: { request } as MobileHttpShell });
  await expect(http.fetch('https://mixed.example/', { destination: 'public-pinned' })).rejects.toMatchObject({
    kind: 'BlockedDestination', address: '::ffff:10.0.0.5',
  });
  await expect(http.fetch('https://[::ffff:127.0.0.1]/', { destination: 'public-pinned' })).rejects.toMatchObject({ kind: 'BlockedDestination' });
  expect(opens).toHaveLength(0);
  await expect(http.fetchBytes('https://first.example/', {
    destination: 'public-pinned', maxBytes: 4, headers: { Authorization: 'secret', 'X-API-Key': 'secret', Accept: 'text/html' },
  })).rejects.toMatchObject({ kind: 'TooLarge' });
  expect(opens).toMatchObject([
    { url: 'https://first.example/', headers: { authorization: 'secret' }, address: Uint8Array.from([93, 184, 216, 34]) },
    { url: 'https://second.example/data', headers: { accept: 'text/html' }, address: Uint8Array.from([93, 184, 216, 35]) },
  ]);
  expect(opens[1]?.headers).not.toHaveProperty('x-api-key');
  expect(opens[1]?.headers).not.toHaveProperty('authorization');
  expect(reads).toBe(2);
  expect(closed).toHaveLength(2);
  expect(web).not.toHaveBeenCalled();
});

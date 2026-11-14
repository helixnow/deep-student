import { describe, expect, it } from 'vitest';
import { createStorageWithCapabilities } from '../index.ts';
import { DESKTOP_CAPABILITIES } from '../src/config.ts';
import type { RuntimeCloudStorageConfig } from '../api.ts';

const nutstore: RuntimeCloudStorageConfig = {
  provider: 'webdav',
  webdav: { endpoint: 'https://dav.jianguoyun.com/dav/', username: 'u', password: 'p' },
} as RuntimeCloudStorageConfig;

async function requestsPerWindow(webdavRateLimit?: string): Promise<number> {
  const storage = await createStorageWithCapabilities(nutstore, DESKTOP_CAPABILITIES,
    webdavRateLimit === undefined ? {} : { webdavRateLimit });
  return (storage as unknown as { requestsPerWindow: number }).requestsPerWindow;
}

describe('webdavRateLimit plugin config (Rust env DEEP_STUDENT_WEBDAV_RATE_LIMIT)', () => {
  it('reaches the WebDAV client and keeps the Nutstore default when absent or invalid', async () => {
    expect(await requestsPerWindow('0')).toBe(0);
    expect(await requestsPerWindow(' 12 ')).toBe(12);
    const fallback = await requestsPerWindow();
    expect(fallback).toBeGreaterThan(0);
    expect(await requestsPerWindow('abc')).toBe(fallback);
  });
});

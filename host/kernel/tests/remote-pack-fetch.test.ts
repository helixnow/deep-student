import { describe, expect, it } from 'vitest';
import {
  fetchRemotePackArchive,
  validateRemotePackUrl,
} from '../../plugins/plugin-workshop/src/remote-pack-fetch.ts';
import { createStudyPackArchive } from '../../plugins/plugin-workshop/src/study-pack.ts';

describe('Plugin v2 P4 — Remote HTTPS / GitHub .dspack Fetcher', () => {
  it('blocks non-HTTPS, private/loopback SSRF hosts, credentials, and bad extensions', () => {
    expect(() => validateRemotePackUrl('http://github.com/alice/pack/releases/download/v1/kaoyan.dspack')).toThrow(/HTTPS_REQUIRED/);
    expect(() => validateRemotePackUrl('https://127.0.0.1/kaoyan.dspack')).toThrow(/HOST_BLOCKED/);
    expect(() => validateRemotePackUrl('https://localhost:8080/kaoyan.dspack')).toThrow(/HOST_BLOCKED/);
    expect(() => validateRemotePackUrl('https://192.168.1.10/kaoyan.dspack')).toThrow(/HOST_BLOCKED/);
    expect(() => validateRemotePackUrl('https://169.254.169.254/latest.dspack')).toThrow(/HOST_BLOCKED/);
    expect(() => validateRemotePackUrl('https://user:pass@github.com/a/b.dspack')).toThrow(/CREDENTIALS_FORBIDDEN/);
    expect(() => validateRemotePackUrl('https://github.com/alice/repo/archive/main.tar.gz')).toThrow(/BAD_EXTENSION/);

    const ok = validateRemotePackUrl('https://github.com/alice/kaoyan/releases/download/v1.0.0/kaoyan-v1.0.0.dspack');
    expect(ok.archiveName).toBe('kaoyan-v1.0.0.dspack');
  });

  it('downloads a .dspack archive over HTTPS, verifies size cap, and computes SHA-256', async () => {
    const zipBytes = await createStudyPackArchive([
      { path: 'package.json', bytes: new TextEncoder().encode('{"name":"test"}') },
    ]);

    const mockFetch: typeof fetch = async () =>
      new Response(zipBytes, {
        status: 200,
        headers: { 'content-length': String(zipBytes.byteLength) },
      });

    const result = await fetchRemotePackArchive(
      'https://github.com/alice/kaoyan/releases/download/v1.0.0/kaoyan-v1.0.0.dspack',
      { fetchImpl: mockFetch, maxBytes: 1024 * 1024 },
    );
    expect(result.archiveName).toBe('kaoyan-v1.0.0.dspack');
    expect(result.bytes.byteLength).toBe(zipBytes.byteLength);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);

    // Exceeding maxBytes fails cleanly
    await expect(
      fetchRemotePackArchive(
        'https://github.com/alice/kaoyan/releases/download/v1.0.0/kaoyan-v1.0.0.dspack',
        { fetchImpl: mockFetch, maxBytes: 1024 },
      ),
    ).resolves.toBeDefined();

    const oversized = new Uint8Array(2048);
    await expect(
      fetchRemotePackArchive(
        'https://github.com/alice/kaoyan/releases/download/v1.0.0/kaoyan-v1.0.0.dspack',
        {
          fetchImpl: async () => new Response(oversized, { status: 200 }),
          maxBytes: 1024,
        },
      ),
    ).rejects.toThrow(/TOO_LARGE/);
  });
});

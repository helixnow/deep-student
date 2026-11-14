import { describe, expect, it, vi } from 'vitest';
import type { FilesService } from '../../files/api.ts';
import { createWebCrypto } from '../../crypto/web.ts';
import { createMobilePaths } from '../mobile.ts';
import { createMobileSecrets } from '../../secrets/mobile.ts';
import { createMobileHttp } from '../../http/mobile.ts';
import { createMobileVector } from '../../vector/mobile.ts';
import { createMobileDiagnostics } from '../../diagnostics/mobile.ts';
import { createMobileLog } from '../../log/mobile.ts';

function memoryFiles() {
  const data = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const files = {
    exists: async (path: string) => data.has(path) || dirs.has(path),
    mkdir: async (path: string) => { dirs.add(path); },
    readText: async (path: string) => new TextDecoder().decode(data.get(path)),
    readBytes: async (path: string) => data.get(path)!,
    writeAtomic: async (path: string, value: string | Uint8Array) => { data.set(path, typeof value === 'string' ? new TextEncoder().encode(value) : value.slice()); },
    rm: async (path: string) => { data.delete(path); },
    readDir: async (path: string) => [...data.keys()].filter(key => key.startsWith(path + '/')).map(key => ({ name: key.slice(path.length + 1) })),
  } as unknown as FilesService;
  return { files, data };
}

describe('staged mobile platform providers', () => {
  it('uses OPFS roots and persists one device identity across service instances', async () => {
    const { files } = memoryFiles();
    const first = createMobilePaths('/app', files);
    const ids = await Promise.all([first.deviceId(), first.deviceId()]);
    expect(ids[0]).toBe(ids[1]);
    expect(await createMobilePaths('/app', files).deviceId()).toBe(ids[0]);
    expect(first.appCacheDir).toBe('/app/cache');
    expect(first.slot.vfsDatabase('/app/slots/slotA')).toBe('/app/slots/slotA/databases/vfs.db');
    const [old, next] = await first.rotateDeviceIdAfterRestore();
    expect(old).toBe(ids[0]);
    expect(next).not.toBe(old);
    expect(await first.deviceId()).toBe(next);
  });

  it('encrypts secrets at rest, reopens them and rejects unsupported keychain/backup operations', async () => {
    const { files, data } = memoryFiles();
    const secrets = createMobileSecrets(files, createWebCrypto(), '/app');
    const store = secrets.openStore('/app');
    await Promise.all([store.saveSecret('api_key.a', 'private-a'), store.saveSecret('token.b', 'private-b')]);
    expect(new TextDecoder().decode(data.get('/app/.secure/api_key.a.enc'))).not.toContain('private-a');
    expect(await createMobileSecrets(files, createWebCrypto(), '/app').openStore('/app').getSecret('api_key.a')).toBe('private-a');
    expect(await store.listSensitiveKeys()).toEqual(new Set(['api_key.a', 'token.b']));
    const bytes = data.get('/app/.secure/api_key.a.enc')!;
    bytes[12] = bytes[12]! ^ 1;
    await expect(store.getSecret('api_key.a')).rejects.toThrow();
    await store.deleteSecret('token.b');
    expect(await store.getSecret('token.b')).toBeNull();
    expect(secrets.isSensitiveKey('openai.api_key')).toBe(true);
    expect(secrets.keystoreSupported()).toBe(false);
    await expect(store.setKeystoreProtection(true)).rejects.toThrow('UNSUPPORTED_ON_PLATFORM');
    expect(() => secrets.backup.encryptBackup(new Uint8Array(), 'password')).toThrow('UNSUPPORTED_ON_PLATFORM');
  });

  it('fetches through Web fetch with response limits and refuses unavailable public policy', async () => {
    const transport = vi.fn(async () => new Response('hello'));
    const http = createMobileHttp(transport as typeof fetch);
    expect(new TextDecoder().decode((await http.fetchBytes('https://example.com', { maxBytes: 5 })).bytes)).toBe('hello');
    await expect(http.fetchBytes('https://example.com', { maxBytes: 4 })).rejects.toMatchObject({ kind: 'TooLarge' });
    await expect(http.fetch('file:///app')).rejects.toMatchObject({ kind: 'InvalidUrl' });
    const calls = transport.mock.calls.length;
    await expect(http.fetch('https://example.com', { destination: 'public' })).rejects.toMatchObject({ kind: 'UnsupportedOnPlatform' });
    await expect(http.checkPublicPinned('https://example.com')).rejects.toMatchObject({ kind: 'UnsupportedOnPlatform' });
    expect(transport.mock.calls.length).toBe(calls);
  });

  it('reports native features unavailable instead of silently providing empty indexes', async () => {
    await expect(createMobileVector().connect('/app/index')).rejects.toThrow('UNSUPPORTED_ON_PLATFORM');
    expect((await createMobileDiagnostics().autoInstallPackageManager('npm')).success).toBe(false);
  });

  it('keeps a bounded redacted log snapshot', () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const log = createMobileLog('/app/logs', 2);
      log.write('info', 'test', 'first'); log.write('info', 'test', 'second'); log.write('info', 'test', 'Bearer private-token-12345');
      expect(log.entries()).toHaveLength(2);
      expect(log.entries().join('\n')).not.toContain('private-token-12345');
      const entries = log.entries() as string[];
      entries.pop();
      expect(log.entries()).toHaveLength(2);
    } finally { consoleLog.mockRestore(); }
  });
});

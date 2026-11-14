/**
 * V06-L8：非安全上下文（局域网 http 调试页、由它创建的 Worker）里 `crypto.getRandomValues` 还在，`crypto.subtle` 与
 * `crypto.randomUUID` 不存在。`createWebCrypto` 在创建时就报出缺什么、为什么，而不是等到第一次摘要才抛
 * `Cannot read properties of undefined (reading 'digest')`。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import mobileCrypto from '../mobile.ts';
import { createWebCrypto, type WebCryptoLike } from '../web.ts';

const insecure = { getRandomValues: <T extends Uint8Array>(array: T): T => array } as unknown as WebCryptoLike;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createWebCrypto checks WebCrypto at creation', () => {
  it('an injected object without subtle / randomUUID is rejected up front, naming what is missing and why', () => {
    expect(() => createWebCrypto({ crypto: insecure })).toThrow(
      'WebCrypto is unavailable (missing crypto.subtle, crypto.randomUUID): they only exist in a secure context (https://, capacitor:// or http://localhost)',
    );
  });

  it('the default globalThis.crypto of an insecure context is rejected the same way', () => {
    vi.stubGlobal('crypto', insecure);
    expect(() => createWebCrypto()).toThrow(/^WebCrypto is unavailable \(missing crypto\.subtle, crypto\.randomUUID\): .*secure context/);
  });

  it('no crypto object at all lists every member', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => createWebCrypto()).toThrow(/^WebCrypto is unavailable \(missing crypto\.subtle, crypto\.getRandomValues, crypto\.randomUUID\)/);
  });

  it('the mobile crypto platform plugin fails to install with that message instead of providing a service that breaks later', async () => {
    vi.stubGlobal('crypto', insecure);
    await expect(createTestHost({ plugins: [mobileCrypto] })).rejects.toThrow(/WebCrypto is unavailable \(missing crypto\.subtle, crypto\.randomUUID\)/);
  });

  it('the Node global WebCrypto (desktop and server Host, tests) passes the check and works', async () => {
    const web = createWebCrypto();
    expect(await web.sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(web.randomUUID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

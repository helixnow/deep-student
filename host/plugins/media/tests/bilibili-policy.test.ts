import { expect, it } from 'vitest';
import {
  BiliRequestError, credentialHost, responseHeader, validateRequest, validateUrl,
} from '../src/bilibili-policy.ts';

it('exact_domains_https_ports_and_credential_scopes', () => {
  for (const value of [
    'https://api.bilibili.com:444/x',
    'https://api.bilibili.com.evil.test/x',
    'http://api.bilibili.com/x',
    'https://127.0.0.1/x',
    'https://a@api.bilibili.com/x',
    'https://api.bilibili.com/x#secret',
  ]) {
    expect(() => validateUrl(new URL(value), 'api'), value).toThrow(BiliRequestError);
  }
  expect(() => validateUrl(new URL('https://api.bilibili.com/x'), 'api')).not.toThrow();
  expect(credentialHost(new URL('https://video.bilivideo.com/x'))).toBe(false);
});

it('media_ports_and_header_allow_lists_match_policy', () => {
  expect(() => validateUrl(new URL('https://upos-sz-mirror.mcdn.bilivideo.cn:4483/x'), 'media')).not.toThrow();
  expect(() => validateUrl(new URL('https://upos-sz-mirror.mcdn.bilivideo.cn:4483/x'), 'api')).toThrow(BiliRequestError);
  expect(() => validateUrl(new URL('https://evil.akamaized.net.evil.test/x'), 'media')).toThrow(BiliRequestError);

  const base = {
    kind: 'api' as const,
    method: 'GET',
    url: new URL('https://api.bilibili.com/x'),
    headers: { range: 'bytes=0-1023' },
    body: new Uint8Array(0),
    maxBytes: 2 * 1024 * 1024,
  };
  expect(() => validateRequest(base)).not.toThrow();
  expect(() => validateRequest({ ...base, method: 'DELETE' })).toThrow(BiliRequestError);
  expect(() => validateRequest({ ...base, body: new Uint8Array(64 * 1024 + 1) })).toThrow(BiliRequestError);
  expect(() => validateRequest({ ...base, maxBytes: 0 })).toThrow(BiliRequestError);
  expect(() => validateRequest({ ...base, headers: { cookie: 'x' } })).toThrow(BiliRequestError);
  expect(() => validateRequest({ ...base, headers: { range: 'x\r\nInjected: 1' } })).toThrow(BiliRequestError);

  expect(responseHeader('content-range')).toBe(true);
  expect(responseHeader('set-cookie')).toBe(false);
});

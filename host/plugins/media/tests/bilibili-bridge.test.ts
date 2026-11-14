import { expect, it } from 'vitest';
import { allowedOrigin, validateRedirectProbe, type BridgeResponse } from '../src/bilibili-bridge.ts';

it('manual_redirect_accepts_manager_normalization_but_not_followed_or_unsafe_targets', () => {
  const local = 'http://127.0.0.1:42/deepstudent-bili-bridge/v1/probe';
  const response: BridgeResponse = {
    status: 301,
    headers: { location: `${local}/target` },
    body: new Uint8Array(0),
    finalUrl: `${local}/redirect`,
  };
  for (const status of [301, 302, 303, 307, 308]) {
    response.status = status;
    expect(() => validateRedirectProbe(response, local)).not.toThrow();
  }
  response.headers.location = '/deepstudent-bili-bridge/v1/probe/target';
  expect(() => validateRedirectProbe(response, local)).not.toThrow();

  for (const location of [
    'http://127.0.0.1:43/target',
    'https://evil.test/',
    '//evil.test/',
    '/other',
  ]) {
    response.headers.location = location;
    expect(() => validateRedirectProbe(response, local), location).toThrow();
  }

  response.headers.location = `${local}/target`;
  response.finalUrl = `${local}/target`;
  expect(() => validateRedirectProbe(response, local)).toThrow();
  response.finalUrl = `${local}/redirect`;
  for (const status of [200, 206, 300, 304, 403]) {
    response.status = status;
    expect(() => validateRedirectProbe(response, local), String(status)).toThrow();
  }
  response.status = 302;
  delete response.headers.location;
  expect(() => validateRedirectProbe(response, local)).toThrow();
});

it('loopback_origin_and_host_cannot_be_rebound', () => {
  expect(allowedOrigin({ host: '127.0.0.1:42', origin: 'http://127.0.0.1:42' }, 42, true)).toBe(true);
  expect(allowedOrigin({ host: 'evil.test:42', origin: 'http://evil.test:42' }, 42, true)).toBe(false);
  expect(allowedOrigin({ host: '127.0.0.1:42', origin: 'https://evil.test' }, 42, true)).toBe(false);
});

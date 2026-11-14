import { BiliAttempt } from '../../src/bilibili-attempt.ts';
import { AuthClient } from '../../src/bilibili-auth.ts';
import { BridgeHub } from '../../src/bilibili-bridge-hub.ts';
import { BiliTransportState } from '../../src/bilibili-transport.ts';

/**
 * The production `AuthClient` over a strict `BiliAttempt.native`; only the final
 * fetch is redirected from passport/api.bilibili.com onto a local fixture.
 */
export function nativeAuthClient(base: string): AuthClient {
  const state = new BiliTransportState({ get: () => null, save: () => undefined });
  const hub = new BridgeHub();
  const fetchImpl: typeof fetch = async (input, init) => {
    const { dispatcher: _dispatcher, ...rest } = (init ?? {}) as RequestInit & { dispatcher?: unknown };
    return fetch(String(input).replace(/^https:\/\/(?:passport|api)\.bilibili\.com/, base), rest);
  };
  return new AuthClient('https://passport.bilibili.com', 'https://api.bilibili.com',
    (cookie) => BiliAttempt.native({ state, hub, nativeCookie: cookie, fetchImpl }));
}

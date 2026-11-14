import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPlatform, isAndroid, isIOS, isLinux, isMacOS, isMobilePlatform, isWindows } from '@/utils/platform';

afterEach(() => {
  delete (globalThis as { __DS_PLATFORM__?: unknown }).__DS_PLATFORM__;
  vi.unstubAllGlobals();
});

function stubNavigator(userAgent: string, platform: string, maxTouchPoints?: number) {
  vi.stubGlobal('navigator', { userAgent, platform, maxTouchPoints });
}

/** The pre-FE-A5 `isMobilePlatform`, verbatim: the oracle for the `isAndroid() || isIOS()` form. */
function legacyIsMobilePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = (navigator.userAgent || '').toLowerCase();
  const pf = (navigator.platform || '').toLowerCase();
  const isIPadOS = pf === 'macintel' && navigator.maxTouchPoints > 1;
  return (
    ua.includes('android') || ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod') ||
    pf.includes('android') || pf.includes('iphone') || pf.includes('ipad') || pf.includes('ipod') ||
    isIPadOS
  );
}

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Electron/33.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  '',
];
const PLATFORMS = ['MacIntel', 'Win32', 'Linux x86_64', 'Linux armv8l', 'iPhone', 'iPad', 'Android', ''];

describe('utils/platform converged on the shell bridge (FE-A5)', () => {
  it('without a shell, isMobilePlatform is unchanged across user agents, platforms and touch points', () => {
    let cases = 0;
    for (const ua of USER_AGENTS) {
      for (const pf of PLATFORMS) {
        for (const touch of [undefined, 0, 1, 5]) {
          stubNavigator(ua, pf, touch);
          expect(isMobilePlatform(), `${ua} | ${pf} | ${touch}`).toBe(legacyIsMobilePlatform());
          cases++;
        }
      }
    }
    expect(cases).toBe(USER_AGENTS.length * PLATFORMS.length * 4);
  });

  it('without a shell, getPlatform still sniffs the user agent', () => {
    stubNavigator(USER_AGENTS[0]!, 'MacIntel', 0);
    expect(getPlatform()).toBe('macos');
    stubNavigator(USER_AGENTS[2]!, 'Linux x86_64', 0);
    expect(getPlatform()).toBe('linux');
  });

  it('with the Electron preload, the shell answers before the user agent', () => {
    stubNavigator(USER_AGENTS[0]!, 'MacIntel', 0);
    globalThis.__DS_PLATFORM__ = Object.freeze({ kind: 'desktop', os: 'win32', arch: 'x64' });
    expect([getPlatform(), isWindows(), isMacOS(), isLinux()]).toEqual(['windows', true, false, false]);
    expect([isAndroid(), isIOS(), isMobilePlatform()]).toEqual([false, false, false]);
  });

  it('a shell os it cannot name falls back to the user agent; a mobile shell decides isAndroid / isIOS', () => {
    stubNavigator(USER_AGENTS[2]!, 'Linux x86_64', 0);
    globalThis.__DS_PLATFORM__ = { kind: 'desktop', os: 'freebsd' };
    expect(getPlatform()).toBe('linux');

    stubNavigator(USER_AGENTS[3]!, 'Linux armv8l', 5);
    globalThis.__DS_PLATFORM__ = { kind: 'mobile', os: 'android' };
    expect([getPlatform(), isAndroid(), isIOS(), isMobilePlatform()]).toEqual(['android', true, false, true]);
  });
});

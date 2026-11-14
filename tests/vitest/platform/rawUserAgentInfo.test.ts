import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPlatform, getRawUserAgentInfo, isAndroid, isIOS, isMacOS, isMobilePlatform } from '@/utils/platform';

const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

function stubNavigator(userAgent: string, platform: string, maxTouchPoints = 0) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, get: () => maxTouchPoints });
}

describe('getRawUserAgentInfo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (navigator as { maxTouchPoints?: number }).maxTouchPoints;
    delete (globalThis as { __DS_PLATFORM__?: unknown }).__DS_PLATFORM__;
  });

  it('returns navigator.userAgent and navigator.platform unchanged, case included', () => {
    stubNavigator(IPAD_UA, 'MacIntel', 5);
    expect(getRawUserAgentInfo()).toEqual({ userAgent: IPAD_UA, platform: 'MacIntel' });
  });

  it('reads the navigator even when the shell bridge names the platform, and leaves the platform checks as they were', () => {
    stubNavigator(IPAD_UA, 'MacIntel', 5);
    expect([getPlatform(), isMacOS(), isIOS(), isAndroid(), isMobilePlatform()]).toEqual(['macos', true, true, false, true]);

    globalThis.__DS_PLATFORM__ = { kind: 'desktop', os: 'win32' };
    expect(getRawUserAgentInfo()).toEqual({ userAgent: IPAD_UA, platform: 'MacIntel' });
    expect([getPlatform(), isMacOS(), isIOS(), isAndroid(), isMobilePlatform()]).toEqual(['windows', false, false, false, false]);
  });
});
